-- 文件加密（边缘版自建 Cloudreve Pro「文件加密」功能，服务端落地的存储侧部分）
--
-- 加密在浏览器端完成（上游前端 Uploader 已内置 EncryptedBlob，走 AES-256-CTR），
-- 服务端只做三件事：
--   1. 上传会话阶段按策略生成每文件的随机密钥 + IV，回传给前端用于客户端加密；
--   2. 把密文相关的密钥材料存到数据库（与存储后端分离，存储方只看到密文）；
--   3. 下载时按存的密钥把密文还原成明文再返回（前端下载/预览无感）。
--
-- files.encrypted        ：文件是否加密的轻量标志，供列表/详情下发（展示锁标）。
-- entities.enc_meta      ：该实体内容的 AES-256-CTR 密钥材料（base64 JSON），
--                          仅存于本仓库数据库，OneDrive/S3/R2 等存储后端只看到密文。
ALTER TABLE files ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS enc_meta TEXT;
