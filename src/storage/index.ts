/**
 * 驱动工厂。对应原版 `pkg/filemanager/manager/fs.go` 的 `GetStorageDriver`。
 *
 *   - `s3`       → 有 AK/SK 时走 S3CompatibleDriver（AWS / 任意 S3 兼容存储）；
 *                  无 AK/SK 且配置了 R2 绑定时走 R2Driver（Worker 绑定直连，
 *                  向后兼容内置的「R2 Default」策略）
 *   - `oss`      → 阿里云 OSS（S3 兼容层 SigV4；官方《使用 AWS SDK 访问 OSS》
 *                  明确支持 V4 签名，但要求带 x-oss-content-sha256 头且禁止
 *                  chunked 传输——见 s3.ts 里的 OSS 专属处理）
 *   - `cos`      → 腾讯云 COS（官方支持 AWS V2/V4 双签名 + 双寻址风格，见
 *                  腾讯云《在兼容亚马逊S3的第三方应用中使用COS》）
 *   - `obs`      → 华为云 OBS（官方「接口层面全面兼容亚马逊 S3，支持 V2/V4
 *                  签名」，region 必须显式）
 *   - `qiniu`    → 七牛 Kodo S3 兼容端点（s3.<region>.qiniucs.com，官方
 *                  《兼容 API》支持 AWS V2/V4 签名与双寻址）
 *   - `ks3`      → 金山 KS3（官方 ks3sdklib 即 aws-sdk-go 的 fork，走 AWS
 *                  S3 协议）
 *   - `onedrive` → OneDriveDriver（Microsoft Graph）
 *   - `upyun`    → 又拍云（**非 S3 协议**，独立 UpyunDriver：自有 REST +
 *                  UPYUN 签名，全中转上传/下载，见 upyun.ts）
 *   - `remote`   → NodeRelayDriver（节点中转，文件落在从节点自己的磁盘上）
 *   - `local`    → 同一份 NodeRelayDriver。Worker 没有本地磁盘，所以「本地文件
 *                  系统存储」只能由节点提供 —— 策略必须绑 `node_id`，
 *                  对应「从节点的本地磁盘」。上游里 `local` 指的是主站所在
 *                  机器的磁盘，云函数里没有这个概念。
 *
 * 拆包说明：`nodeRelay.ts` 只依赖 lib/db，不 import 任何路由。
 */
import type { Env } from '../env';
import type { StoragePolicyRow } from '../db/types';
import { AppError, CodePolicyNotAllowed } from '../lib/errors';
import { PolicyType } from '../lib/boolset';
import { R2Driver } from './r2';
import { OneDriveDriver } from './onedrive';
import { S3CompatibleDriver } from './s3';
import { UpyunDriver } from './upyun';
import { NodeRelayDriver } from './nodeRelay';
import { requireNode } from '../db/nodes';
import { loadSettings } from '../settings/provider';
import { BACKEND_VERSION } from '../lib/version';
import type { StorageDriver } from './types';

/** 当前实现支持的策略类型。 */
export const SUPPORTED_POLICY_TYPES = [
  PolicyType.S3,
  PolicyType.Oss,
  PolicyType.Cos,
  PolicyType.Obs,
  PolicyType.Qiniu,
  PolicyType.Ks3,
  PolicyType.OneDrive,
  PolicyType.Upyun,
  PolicyType.Local,
  PolicyType.Remote,
] as const;

/** 必须绑定从节点才能工作的类型（Worker 侧没有本地磁盘）。 */
export const NODE_BOUND_POLICY_TYPES: readonly string[] = [PolicyType.Local, PolicyType.Remote];

export function isNodeBoundPolicyType(type: string): boolean {
  return NODE_BOUND_POLICY_TYPES.includes(type);
}

/**
 * 节点存储驱动：把「查节点 + 站点信息」注入进去，驱动自身不碰 db。
 * 站点信息（siteId/siteUrl/版本）随每个 RPC 带给从机，从机用它拼回调地址。
 */
function createNodeRelayDriver(env: Env, policy: StoragePolicyRow): NodeRelayDriver {
  return new NodeRelayDriver(policy, async (p) => {
    const [node, settings] = await Promise.all([requireNode(env, p.node_id), loadSettings(env)]);
    return {
      node,
      meta: {
        siteId: settings.siteId,
        siteUrl: settings.siteUrl,
        version: BACKEND_VERSION,
      },
    };
  });
}

export function getStorageDriver(env: Env, policy: StoragePolicyRow): StorageDriver {
  switch (policy.type) {
    case PolicyType.S3:
      // 兼容内置 R2 策略：没填 AK/SK 就用 Worker 的 R2 绑定。
      // R2 绑定是可选的（不绑也能跑）：两边都没有时给明确错误，
      // 而不是让 S3CompatibleDriver 拿空凭证在请求时才爆。
      if (!policy.access_key && !env.R2) {
        throw new AppError(
          CodePolicyNotAllowed,
          `Storage policy "${policy.name}" has no access_key and no R2 binding: ` +
            'bind an R2 bucket in wrangler.toml, or fill access_key/secret_key ' +
            'with any S3-compatible endpoint (COS / OBS / MinIO / R2 S3 API)',
        );
      }
      if (!policy.access_key && env.R2) return new R2Driver(env, policy);
      return new S3CompatibleDriver(policy);
    case PolicyType.Oss:
    case PolicyType.Cos:
    case PolicyType.Obs:
    case PolicyType.Qiniu:
    case PolicyType.Ks3:
      return new S3CompatibleDriver(policy);
    case PolicyType.OneDrive:
      return new OneDriveDriver(env, policy);
    case PolicyType.Upyun:
      return new UpyunDriver(policy);
    case PolicyType.Local:
    case PolicyType.Remote:
      if (!policy.node_id) {
        throw new AppError(
          CodePolicyNotAllowed,
          `Storage policy "${policy.name}" must be bound to a node: ` +
            'the edge build has no local disk, node storage is the only way to keep files on a disk',
        );
      }
      return createNodeRelayDriver(env, policy);
    default:
      throw new AppError(
        CodePolicyNotAllowed,
        `Storage policy type "${policy.type}" is not supported by the edge build`,
      );
  }
}

/** 该策略类型是否可用（用于过滤策略列表、校验用户组绑定）。 */
export function isPolicyTypeSupported(type: string): boolean {
  return (SUPPORTED_POLICY_TYPES as readonly string[]).includes(type);
}

/**
 * 可被创建/绑定/展示的策略类型 = 有驱动的 + 虚拟的 load_balance
 * （它没有驱动，但在策略解析层展开，见 storage/loadBalance.ts）。
 */
export function isSelectablePolicyType(type: string): boolean {
  return type === PolicyType.LoadBalance || isPolicyTypeSupported(type);
}

export * from './types';
export { R2Driver } from './r2';
export { OneDriveDriver } from './onedrive';
export { S3CompatibleDriver } from './s3';
export { UpyunDriver } from './upyun';
export { NodeRelayDriver } from './nodeRelay';
