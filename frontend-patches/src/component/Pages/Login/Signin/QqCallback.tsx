import { Box, CircularProgress, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sendQqCallback } from "../../../../api/api.ts";
import { useAppDispatch } from "../../../../redux/hooks.ts";
import { refreshUserSession } from "../../../../redux/thunks/session.ts";
import { useQuery } from "../../../../util/index.ts";

/**
 * 第三方登录（QQ 互联，edge 自建）回调页。
 *
 * 后端 `/session/qq/login` → QQ 授权页 → `/session/qq/callback`（带 code & state）
 * → 这里（同一路径的页面形态）。拿到后调 `/session/qq/callback` 换本站 token，
 * 再走与密码登录一致的 `refreshUserSession` 落地，最后跳回 return_to（默认 /home）。
 */
const QqCallback = () => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const query = useQuery();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const code = query.get("code");
    const state = query.get("state");
    const errorParam = query.get("error");

    if (errorParam) {
      setError(`QQ 登录失败：${errorParam}`);
      return;
    }
    if (!code || !state) {
      setError("缺少 code 或 state 参数");
      return;
    }

    dispatch(sendQqCallback({ code, state }))
      .then((res) => {
        // 后端把发起登录时的 ?redirect= 原样带回（已校验为站内相对路径），
        // 没有就回首页 —— 之前固定 /home，用户在分享页点登录会被踢回首页。
        const to = res?.return_to && res.return_to.startsWith("/") ? res.return_to : "/home";
        dispatch(refreshUserSession(res, to));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        pt: 10,
        pb: 9,
      }}
    >
      {!error && <CircularProgress />}
      {!error && <Typography variant="body2">正在完成登录…</Typography>}
      {error && (
        <>
          <Typography color="error" variant="body2">
            {error}
          </Typography>
          <Typography
            variant="body2"
            sx={{ cursor: "pointer", textDecoration: "underline" }}
            onClick={() => navigate("/session", { replace: true })}
          >
            返回登录页
          </Typography>
        </>
      )}
    </Box>
  );
};

export default QqCallback;
