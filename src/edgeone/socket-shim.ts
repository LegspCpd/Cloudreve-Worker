/**
 * `cloudflare:sockets` 的 Node 实现（EdgeOne Node 云函数专用）。
 *
 * 为什么存在：`services/smtp.ts` 静态 import `cloudflare:sockets` 的
 * `connect`（CF Workers 的 TCP socket API）。EdgeOne 的 Node 运行时没有
 * 这个模块，esbuild 打包会在解析阶段直接失败。打包脚本
 * （scripts/build-edgeone.mjs）把这个模块 alias 到这里，CF 的 wrangler
 * 构建不受影响（它继续用平台原生实现）。
 *
 * 接口对齐 CF Workers TCP Sockets：
 *   connect({hostname, port}, {secureTransport, allowHalfOpen}) → Socket
 *   Socket: opened / readable / writable / startTls() / close()
 *
 * ⚠️ 只覆盖 SMTP 用到的那部分语义：
 *   - `secureTransport: "starttls"`：明文连上后由调用方 `startTls()` 升级；
 *   - `secureTransport: "on"`：连上即 TLS（465 隐式 TLS）；
 *   - 读写走 Web Streams（Node 18+ 的 Readable.toWeb / Writable.toWeb）。
 */
import { connect as netConnect, type Socket as NetSocket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Readable, Writable } from 'node:stream';

interface CfSocketOptions {
  secureTransport?: 'starttls' | 'on' | 'off';
  allowHalfOpen?: boolean;
}

interface CfSocket {
  opened: Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): CfSocket;
  close(): void;
}

/** 把 Node 的 net/tls socket 包装成 CF 风格的 Web-streams socket。 */
function wrap(socket: NetSocket | TLSSocket): CfSocket {
  const opened = new Promise<void>((resolve, reject) => {
    if (socket.readyState === 'open') {
      resolve();
      return;
    }
    socket.once('connect', () => resolve());
    socket.once('error', (err) => reject(err));
    socket.once('close', () => {
      // 连接被对端关闭且从未 open 过：给出可读的错误
      reject(new Error('connection closed before established'));
    });
  });

  const base = {
    opened,
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
    close() {
      socket.destroy();
    },
  };

  return {
    ...base,
    // STARTTLS：在既有明文连接上原地升级。Node 的 tls.connect({socket})
    // 正是干这个的；升级后 readable/writable 换成 TLS 流的。
    startTls(): CfSocket {
      if (!('encrypted' in socket)) {
        const tls = tlsConnect({ socket: socket as NetSocket }) as TLSSocket;
        tls.once('error', () => socket.destroy());
        return wrap(tls);
      }
      return base as CfSocket; // 已经是 TLS，重复调用返回自身
    },
  };
}

export function connect(
  addr: { hostname: string; port: number },
  opts: CfSocketOptions = {},
): CfSocket {
  const { hostname, port } = addr;
  if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid address: ${hostname}:${port}`);
  }
  if (opts.secureTransport === 'on') {
    // 隐式 TLS（465）：连上就是 TLS
    return wrap(tlsConnect({ host: hostname, port }));
  }
  // 明文（后续可能 STARTTLS）
  return wrap(netConnect({ host: hostname, port }));
}
