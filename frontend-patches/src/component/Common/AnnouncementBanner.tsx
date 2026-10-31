/**
 * 站点公告横幅（edge 自建 Pro 功能）。
 *
 * 读取 /site/config 的 announcement 字段（落库在 settings.announcement）。
 * 管理员在「增值服务」设置页配置；此处只做纯文本展示（不渲染 HTML），
 * 可手动关闭（仅当前会话）。空内容不渲染。
 */
import { Alert, IconButton } from "@mui/material";
import { Close } from "@mui/icons-material";
import { useState } from "react";
import { useAppSelector } from "../../redux/hooks.ts";

const AnnouncementBanner = () => {
  const announcement = useAppSelector(
    (state) => (state.siteConfig.basic.config as { announcement?: string }).announcement ?? "",
  );
  const [dismissed, setDismissed] = useState(false);
  if (!announcement || dismissed) return null;
  return (
    <Alert
      severity="info"
      sx={{ borderRadius: 0, "& .MuiAlert-message": { width: "100%" } }}
      action={
        <IconButton size="small" aria-label="close" onClick={() => setDismissed(true)}>
          <Close fontSize="inherit" />
        </IconButton>
      }
    >
      {announcement}
    </Alert>
  );
};

export default AnnouncementBanner;
