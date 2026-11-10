/**
 * ESA 专用：postgres.js 的占位实现。
 *
 * ESA 运行时（V8 isolate + 部分 Node APIs）没有 net/tls，postgres.js 的
 * TCP 线协议连不上，且会在打包时把 node:net 等模块拖进来。这里在构建期
 * 把 `postgres` alias 成它：正常情况下永远不会被调用（ESA 部署统一走
 * Neon HTTP 驱动），万一路由判断误落到 postgres 分支，给出可读错误而不是
 * 一段难懂的模块解析失败。
 */
export default function postgresUnsupported(): never {
  throw new Error(
    'ESA runtime has no TCP sockets: PostgreSQL direct connections are unavailable. ' +
      'Set DATABASE_URL to a Neon HTTP endpoint (DB_PROVIDER is forced to "neon" for ESA).',
  );
}
