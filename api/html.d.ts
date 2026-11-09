// EdgeOne 构建期内联的 SPA 壳（build-edgeone.mjs 的 .html text loader）。
declare module '*.html' {
  const content: string;
  export default content;
}
