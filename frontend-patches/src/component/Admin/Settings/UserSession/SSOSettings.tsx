import { ExpandMoreRounded } from "@mui/icons-material";
import { Accordion, AccordionDetails, FormControl, FormControlLabel, Stack, styled, Switch } from "@mui/material";
import MuiAccordionSummary, { AccordionSummaryProps } from "@mui/material/AccordionSummary";
import { useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTrueVal } from "../../../../session/utils.ts";
import { DenseFilledTextField } from "../../../Common/StyledComponents.tsx";
import { NoMarginHelperText } from "../Settings.tsx";
import { SettingContext } from "../SettingWrapper.tsx";

export const AccordionSummary = styled((props: AccordionSummaryProps) => <MuiAccordionSummary {...props} />)(
  ({ theme }) => ({
    fontSize: theme.typography.body2.fontSize,
    paddingLeft: theme.spacing(4),
    "& .MuiFormControlLabel-label": {
      fontSize: theme.typography.body2.fontSize,
    },
    "& .MuiCheckbox-root": {
      marginRight: theme.spacing(2),
    },
  }),
);

export const StyledAccordion = styled(Accordion)(({ theme }) => ({
  boxShadow: "none",
  border: `1px solid ${theme.palette.divider}`,
  "&::before": {
    display: "none",
  },
}));

export interface SettingSectionProps {}

/**
 * 第三方登录设置（edge 自建实现）。
 *
 * 官方开源前端里这块是纯 Pro 装饰位：三个 checkbox（QQ / Logto / OIDC）全部
 * `checked={false}` 且无 `onChange`，点击只弹 ProDialog。边缘版把后端补齐了
 * （见 src/services/oidc.ts，实现了通用的 OIDC 授权码登录），这里用真实控件
 * 对接。QQ 互联与 Logto 都是标准 OIDC/OAuth2，共用同一套配置，无需分家。
 */
const SSOSettings = () => {
  const [expanded, setExpanded] = useState(false);
  const [qqExpanded, setQqExpanded] = useState(false);
  const { t } = useTranslation("dashboard");
  const { values, setSettings } = useContext(SettingContext);

  const enabled = isTrueVal(values.oidc_enabled);
  const qqEnabled = isTrueVal(values.qq_enabled);

  const onToggle = useCallback(
    (checked: boolean) => {
      setSettings({ oidc_enabled: checked ? "1" : "0" });
    },
    [setSettings],
  );

  const onQqToggle = useCallback(
    (checked: boolean) => {
      setSettings({ qq_enabled: checked ? "1" : "0" });
    },
    [setSettings],
  );

  return (
    <>
      <StyledAccordion expanded={expanded} disableGutters onChange={(_e, exp) => setExpanded(exp)}>
        <AccordionSummary expandIcon={<ExpandMoreRounded />}>
          <FormControlLabel
            control={
              <Switch
                size={"small"}
                checked={enabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onToggle(e.target.checked)}
              />
            }
            label={t("settings.oidc")}
            onClick={(e) => e.stopPropagation()}
          />
        </AccordionSummary>
        <AccordionDetails sx={{ display: "block" }}>
          <Stack spacing={2}>
            <FormControl fullWidth>
              <DenseFilledTextField
                label={"显示名称"}
                value={values.oidc_name ?? ""}
                onChange={(e) => setSettings({ oidc_name: e.target.value })}
                placeholder={"OpenID Connect"}
              />
              <NoMarginHelperText>登录页第三方登录按钮上显示的文字。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth required>
              <DenseFilledTextField
                label={"Issuer 地址"}
                value={values.oidc_issuer ?? ""}
                onChange={(e) => setSettings({ oidc_issuer: e.target.value })}
                placeholder={"https://accounts.example.com"}
              />
              <NoMarginHelperText>
                身份提供方的 Issuer，须支持 `/.well-known/openid-configuration` 发现文档。
              </NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <DenseFilledTextField
                label={"Client ID"}
                value={values.oidc_client_id ?? ""}
                onChange={(e) => setSettings({ oidc_client_id: e.target.value })}
              />
              <NoMarginHelperText>在身份提供方创建应用后获得的 Client ID。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <DenseFilledTextField
                label={"Client Secret"}
                value={values.oidc_client_secret ?? ""}
                onChange={(e) => setSettings({ oidc_client_secret: e.target.value })}
                type={"password"}
              />
              <NoMarginHelperText>Client Secret（公开客户端可留空，此时走 PKCE）。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <DenseFilledTextField
                label={"Scope"}
                value={values.oidc_scopes ?? ""}
                onChange={(e) => setSettings({ oidc_scopes: e.target.value })}
                placeholder={"openid profile email"}
              />
              <NoMarginHelperText>请求的 scope，空格分隔，须包含 openid。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <FormControlLabel
                control={
                  <Switch
                    checked={isTrueVal(values.oidc_auto_register)}
                    onChange={(e) => setSettings({ oidc_auto_register: e.target.checked ? "1" : "0" })}
                  />
                }
                label={"允许自动注册"}
              />
              <NoMarginHelperText>
                开启后，首次通过 OIDC 登录且本地无对应账号时将自动创建账号；关闭则要求先绑定已有账号。
              </NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <DenseFilledTextField
                value={`${window.location.origin}/api/v4/session/oidc/callback`}
                label={"回调地址（Callback URL）"}
                slotProps={{ input: { readOnly: true } }}
              />
              <NoMarginHelperText>
                请把该地址填入身份提供方的回调白名单（Redirect URI）。
                必须带 <code>/api/v4</code> 前缀 —— 这是后端换取 token 的端点，
                与前端页面路由 <code>/session/oidc/callback</code> 不是同一个。
              </NoMarginHelperText>
            </FormControl>
          </Stack>
        </AccordionDetails>
      </StyledAccordion>

      <StyledAccordion expanded={qqExpanded} disableGutters onChange={(_e, exp) => setQqExpanded(exp)}>
        <AccordionSummary expandIcon={<ExpandMoreRounded />}>
          <FormControlLabel
            control={
              <Switch
                size={"small"}
                checked={qqEnabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onQqToggle(e.target.checked)}
              />
            }
            label={"QQ 互联"}
            onClick={(e) => e.stopPropagation()}
          />
        </AccordionSummary>
        <AccordionDetails sx={{ display: "block" }}>
          <Stack spacing={2}>
            <FormControl fullWidth>
              <DenseFilledTextField
                label={"显示名称"}
                value={values.qq_name ?? ""}
                onChange={(e) => setSettings({ qq_name: e.target.value })}
                placeholder={"QQ"}
              />
              <NoMarginHelperText>登录页第三方登录按钮上显示的文字。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth required>
              <DenseFilledTextField
                label={"App ID"}
                value={values.qq_app_id ?? ""}
                onChange={(e) => setSettings({ qq_app_id: e.target.value })}
              />
              <NoMarginHelperText>QQ 互联开放平台创建应用后获得的 App ID。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth required>
              <DenseFilledTextField
                label={"App Key"}
                value={values.qq_app_secret ?? ""}
                onChange={(e) => setSettings({ qq_app_secret: e.target.value })}
                type={"password"}
              />
              <NoMarginHelperText>QQ 互联开放平台创建应用后获得的 App Key。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <DenseFilledTextField
                label={"Scope"}
                value={values.qq_scope ?? ""}
                onChange={(e) => setSettings({ qq_scope: e.target.value })}
                placeholder={"get_user_info"}
              />
              <NoMarginHelperText>请求的 scope，QQ 互联默认 get_user_info 即可获取昵称与头像。</NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <FormControlLabel
                control={
                  <Switch
                    checked={isTrueVal(values.qq_auto_register)}
                    onChange={(e) => setSettings({ qq_auto_register: e.target.checked ? "1" : "0" })}
                  />
                }
                label={"允许自动注册"}
              />
              <NoMarginHelperText>
                开启后，首次通过 QQ 登录且本地无对应账号时将自动创建账号；关闭则要求先绑定已有账号。
              </NoMarginHelperText>
            </FormControl>
            <FormControl fullWidth>
              <DenseFilledTextField
                value={`${window.location.origin}/api/v4/session/qq/callback`}
                label={"回调地址（Callback URL）"}
                slotProps={{ input: { readOnly: true } }}
              />
              <NoMarginHelperText>
                请把该地址填入 QQ 互联开放平台应用的回调白名单。必须带{" "}
                <code>/api/v4</code> 前缀，否则 QQ 会报 redirect_uri 不一致（100010）。
              </NoMarginHelperText>
            </FormControl>
          </Stack>
        </AccordionDetails>
      </StyledAccordion>
    </>
  );
};

export default SSOSettings;
