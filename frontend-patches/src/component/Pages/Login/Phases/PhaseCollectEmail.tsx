import { Box, Button, Divider, FormControl, Link, Stack } from "@mui/material";
import { useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { LoginResponse } from "../../../../api/user.ts";
import { useAppSelector } from "../../../../redux/hooks.ts";
import { useQuery } from "../../../../util";
import { OutlineIconTextField } from "../../../Common/Form/OutlineIconTextField.tsx";
import MailOutlined from "../../../Icons/MailOutlined.tsx";
import PasskeyLoginButton from "../Signin/PasskeyLoginButton.tsx";
import { Control } from "../Signin/SignIn.tsx";

export const LegalLinks = () => {
  const { t } = useTranslation();
  const tos = useAppSelector((state) => state.siteConfig.login.config.tos_url);
  const privacyPolicy = useAppSelector((state) => state.siteConfig.login.config.privacy_policy_url);
  return (
    <>
      {(tos || privacyPolicy) && (
        <Box
          sx={{
            mt: 2,
            color: "text.secondary",
            typography: "caption",
            textAlign: "center",
          }}
        >
          {tos && (
            <Link target={"_blank"} underline="hover" color={"inherit"} href={tos}>
              {t("login.termOfUse")}
            </Link>
          )}
          {tos && privacyPolicy && " | "}
          {privacyPolicy && (
            <Link target={"_blank"} underline="hover" color={"inherit"} href={privacyPolicy}>
              {t("login.privacyPolicy")}
            </Link>
          )}
        </Box>
      )}
    </>
  );
};

interface PhaseCollectEmailProps {
  email: string;
  setEmail: (email: string) => void;
  control?: Control;
  onOAuthPasskeyLogin?: (response: LoginResponse) => void;
}

const PhaseCollectEmail = ({ email, setEmail, control, onOAuthPasskeyLogin }: PhaseCollectEmailProps) => {
  const { t } = useTranslation();
  const query = useQuery();
  const { register_enabled, authn, oidc_enabled, oidc_name, qq_enabled, qq_name } = useAppSelector((state) => state.siteConfig.login.config);
  const tos = useAppSelector((state) => state.siteConfig.login.config.tos_url);
  const privacyPolicy = useAppSelector((state) => state.siteConfig.login.config.privacy_policy_url);

  const showFooter = tos || privacyPolicy || authn || oidc_enabled || qq_enabled;

  useEffect(() => {
    if (!!query.get("email")) {
      setEmail(query.get("email") ?? "");
    }
  }, []);

  // 第三方登录（OIDC，edge 自建）：跳转到后端 /session/oidc/login，
  // 由后端 302 到 IdP，认证后回落到 /session/oidc/callback 页面。
  const startOidcLogin = () => {
    const redirect = query.get("redirect") ?? "/home";
    window.location.href = `/api/v4/session/oidc/login?redirect=${encodeURIComponent(redirect)}`;
  };

  // 第三方登录（QQ 互联，edge 自建）：跳转到后端 /session/qq/login，
  // 由后端 302 到 QQ 授权页，认证后回落到 /session/qq/callback 页面。
  const startQqLogin = () => {
    const redirect = query.get("redirect") ?? "/home";
    window.location.href = `/api/v4/session/qq/login?redirect=${encodeURIComponent(redirect)}`;
  };

  return (
    <>
      <FormControl variant="standard" margin="normal" required fullWidth>
        <OutlineIconTextField
          label={t("login.email")}
          variant={"outlined"}
          inputProps={{
            id: "email",
            type: "email",
            name: "email",
            required: "true",
          }}
          onChange={(e) => setEmail(e.target.value)}
          icon={<MailOutlined />}
          autoComplete={"username webauthn"}
          value={email}
          autoFocus
        />
      </FormControl>
      {control?.submit}
      {control?.back}
      {register_enabled && (
        <Box sx={{ mt: 2, typography: "body2", textAlign: "center" }}>
          <Trans
            ns={"application"}
            i18nKey={"login.noAccountSignupNow"}
            components={[<Link underline="hover" component={RouterLink} to="/session/signup" />]}
          />
        </Box>
      )}
      {showFooter && (
        <>
          <Divider sx={{ my: 2 }} />
          <Stack spacing={1}>
            {authn && <PasskeyLoginButton autoComplete onLoginSuccess={onOAuthPasskeyLogin} />}
            {oidc_enabled && (
              <Button fullWidth variant="outlined" color="primary" onClick={startOidcLogin}>
                {`使用 ${oidc_name || "OpenID Connect"} 登录`}
              </Button>
            )}
            {qq_enabled && (
              <Button fullWidth variant="outlined" color="primary" onClick={startQqLogin}>
                {`使用 ${qq_name || "QQ"} 登录`}
              </Button>
            )}
          </Stack>
          <LegalLinks />
        </>
      )}
    </>
  );
};

export default PhaseCollectEmail;
