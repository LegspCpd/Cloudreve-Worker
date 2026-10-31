/**
 * 增值服务设置页（edge 自建实现）。
 *
 * 官方开源前端里这个页面是纯 Pro 装饰位（全 readOnly + checked={false} +
 * 弹 Pro 购买框）。边缘版把后端补齐了（见 src/services/payment.ts），这里
 * 用真实控件重写：所有字段绑定 SettingContext，走 SettingsWrapper 的通用
 * 保存链路（PATCH /admin/settings）；礼品卡走 /api/v4/payment/admin/giftcode。
 */
import { Add, Delete, Edit } from "@mui/icons-material";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useSnackbar } from "notistack";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SecondaryButton, StyledTableContainerPaper, DenseFilledTextField } from "../../../Common/StyledComponents.tsx";
import { NoMarginHelperText, SettingSection, SettingSectionContent } from "../Settings.tsx";
import { SettingContext } from "../SettingWrapper.tsx";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface PaymentProvider {
  id: string;
  name: string;
  type: "epay";
  enabled: boolean;
  epay_url: string;
  pid: string;
  key: string;
  channel: string;
}

interface StorageProduct {
  id: string;
  name: string;
  price: number;
  size: number;
  duration: number;
}

interface GroupProduct {
  id: string;
  name: string;
  price: number;
  group_id: number;
  duration: number;
}

interface CreditProduct {
  id: string;
  name: string;
  price: number;
  credit: number;
}

interface GiftCodeRow {
  id: number;
  code: string;
  product_type: string;
  product_payload: { name?: string };
  used_by: number | null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const GB = 1024 * 1024 * 1024;

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return v as T;
  } catch {
    return fallback;
  }
}

/** 直接调管理端 API（SettingsWrapper 的 redux 链路不便复用，这里用原生 fetch）。 */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = JSON.parse(localStorage.getItem("cloudreve_session") || "{}");
  const first = Object.values(session?.sessions ?? {})[0] as
    | { token?: { access_token?: string } }
    | undefined;
  const token = first?.token?.access_token ?? "";
  const res = await fetch("/api/v4" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: "Bearer " + token,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (json.code !== undefined && json.code !== 0) throw new Error(json.msg || "request failed");
  return json.data as T;
}

const fmtBytes = (n: number) => {
  if (!n) return "0";
  if (n >= GB) return Number((n / GB).toFixed(1)) + " GB";
  if (n >= 1024 * 1024) return Number((n / 1024 / 1024).toFixed(1)) + " MB";
  return n + " B";
};

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

const VAS = () => {
  const { t } = useTranslation("dashboard");
  const { enqueueSnackbar } = useSnackbar();
  const { values, setSettings } = useContext(SettingContext);

  const text = (key: string) => values[key] ?? "";
  const setText = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings({ [key]: e.target.value });

  const providers = useMemo(() => parseJson<PaymentProvider[]>(values.payment, []), [values.payment]);
  const storageProducts = useMemo(() => parseJson<StorageProduct[]>(values.storage_products, []), [values.storage_products]);
  const groupProducts = useMemo(() => parseJson<GroupProduct[]>(values.group_sell_data, []), [values.group_sell_data]);
  const creditProducts = useMemo(() => parseJson<CreditProduct[]>(values.credit_products, []), [values.credit_products]);

  const updateJson = (key: string, list: unknown[]) => setSettings({ [key]: JSON.stringify(list, null, 2) });

  // 组列表（组商品下拉）
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    api<{ groups: { id: number; name: string }[] }>("POST", "/admin/group", { page: 0, page_size: 100 })
      .then((res) => setGroups(res.groups ?? []))
      .catch(() => undefined);
  }, []);

  // ------------------------------------------------------------------ 支付提供商
  const [providerDialog, setProviderDialog] = useState<{
    open: boolean;
    index: number;
    value: PaymentProvider;
  } | null>(null);

  const newProvider = (): PaymentProvider => ({
    id: "epay_" + Math.random().toString(36).slice(2, 8),
    name: "",
    type: "epay",
    enabled: true,
    epay_url: "",
    pid: "",
    key: "",
    channel: "alipay",
  });

  // ------------------------------------------------------------------ 礼品卡
  const [giftCodes, setGiftCodes] = useState<GiftCodeRow[]>([]);
  const [giftDialog, setGiftDialog] = useState(false);
  const [giftForm, setGiftForm] = useState({
    count: 10,
    product_type: "storage" as "storage" | "group" | "credit",
    name: "容量礼品卡",
    size_gb: 5,
    duration: 0,
    group_id: 0,
    credit: 100,
  });
  const [lastCodes, setLastCodes] = useState<string[]>([]);

  const loadGiftCodes = () => {
    api<{ gift_codes: GiftCodeRow[] }>("GET", "/payment/admin/giftcode?page=1&page_size=20")
      .then((res) => setGiftCodes(res.gift_codes ?? []))
      .catch((e) => enqueueSnackbar(String(e.message ?? e), { variant: "error" }));
  };
  useEffect(loadGiftCodes, []);

  const generateGiftCodes = async () => {
    try {
      const body: Record<string, unknown> = {
        count: Number(giftForm.count) || 1,
        product_type: giftForm.product_type,
        name: giftForm.name,
      };
      if (giftForm.product_type === "storage") {
        body.size = Math.round(Number(giftForm.size_gb) * GB);
        body.duration = Number(giftForm.duration) || 0;
      } else if (giftForm.product_type === "group") {
        body.group_id = Number(giftForm.group_id);
        body.duration = Number(giftForm.duration) || 0;
      } else {
        body.credit = Number(giftForm.credit) || 0;
      }
      const res = await api<{ codes: string[] }>("POST", "/payment/admin/giftcode", body);
      setLastCodes(res.codes ?? []);
      setGiftDialog(false);
      loadGiftCodes();
      enqueueSnackbar(t("vas.vas") + ": " + (res.codes?.length ?? 0) + " codes", { variant: "success" });
    } catch (e) {
      enqueueSnackbar(String((e as Error).message ?? e), { variant: "error" });
    }
  };

  const deleteGiftCode = async (id: number) => {
    try {
      await api("DELETE", "/payment/admin/giftcode/" + id);
      loadGiftCodes();
    } catch (e) {
      enqueueSnackbar(String((e as Error).message ?? e), { variant: "error" });
    }
  };

  return (
    <Stack spacing={5}>
      {/* ---------------- 积分与商店开关 ---------------- */}
      <SettingSection>
        <Typography variant="h6" gutterBottom>
          {t("settings.creditAndVAS")}
        </Typography>
        <SettingSectionContent>
          <SettingRow>
            <FormControl fullWidth>
              <FormControlLabel
                control={
                  <Switch
                    checked={text("shop_nav_enabled") === "1"}
                    onChange={(e) => setSettings({ shop_nav_enabled: e.target.checked ? "1" : "0" })}
                  />
                }
                label={t("settings.shopNavEnabled")}
              />
              <NoMarginHelperText>{t("settings.shopNavEnabledDes")}</NoMarginHelperText>
            </FormControl>
          </SettingRow>
          <SettingRow>
            <FormControl fullWidth>
              <FormControlLabel
                control={
                  <Switch
                    checked={text("credit_enabled") === "1"}
                    onChange={(e) => setSettings({ credit_enabled: e.target.checked ? "1" : "0" })}
                  />
                }
                label={t("settings.enableCredit")}
              />
              <NoMarginHelperText>{t("settings.enableCreditDes")}</NoMarginHelperText>
            </FormControl>
          </SettingRow>
          <SettingRow>
            <Stack direction={"row"} spacing={2} width={"100%"}>
              <TextField
                fullWidth
                label={t("settings.currencyCode")}
                value={text("currency_code")}
                onChange={setText("currency_code")}
              />
              <TextField
                fullWidth
                label={t("settings.currencySymbol")}
                value={text("currency_symbol")}
                onChange={setText("currency_symbol")}
              />
              <TextField
                fullWidth
                type="number"
                label={t("settings.currencyUnit")}
                value={text("currency_unit")}
                onChange={setText("currency_unit")}
              />
            </Stack>
          </SettingRow>
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 支付提供商 ---------------- */}
      <SettingSection>
        <Typography variant="h6" gutterBottom>
          {t("settings.paymentSettings")}
        </Typography>
        <SettingSectionContent>
          <Box sx={{ mb: 1 }}>
            <SecondaryButton
              variant="contained"
              startIcon={<Add />}
              onClick={() => setProviderDialog({ open: true, index: -1, value: newProvider() })}
            >
              {t("settings.addPaymentProvider")}
            </SecondaryButton>
          </Box>
          <ProductTable
            head={[t("settings.displayName"), "类型", "网关", "渠道", "状态", t("settings.actions")]}
            rows={providers.map((p, i) => [
              p.name || p.id,
              "易支付",
              p.epay_url,
              p.channel,
              <Chip size="small" color={p.enabled ? "success" : "default"} label={p.enabled ? "启用" : "停用"} />,
              <IconButton
                size="small"
                onClick={() => setProviderDialog({ open: true, index: i, value: { ...p } })}
              >
                <Edit />
              </IconButton>,
            ])}
            empty={providers.length === 0}
          />
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 容量商品 ---------------- */}
      <SettingSection>
        <Typography variant="h6" gutterBottom>
          {t("settings.storageProductSettings")}
        </Typography>
        <SettingSectionContent>
          <Box sx={{ mb: 1 }}>
            <SecondaryButton
              variant="contained"
              startIcon={<Add />}
              onClick={() =>
                updateJson("storage_products", [
                  ...storageProducts,
                  {
                    id: "sp_" + Math.random().toString(36).slice(2, 8),
                    name: "新容量包",
                    price: 10,
                    size: 10 * GB,
                    duration: 0,
                  },
                ])
              }
            >
              {t("settings.addStorageProduct")}
            </SecondaryButton>
          </Box>
          <ProductTable
            head={[t("settings.displayName"), t("settings.price"), "容量", "有效期(天)", t("settings.actions")]}
            rows={storageProducts.map((p, i) => [
              <DenseFilledTextField
                fullWidth
                value={p.name}
                onChange={(e) => {
                  const next = [...storageProducts];
                  next[i] = { ...p, name: e.target.value };
                  updateJson("storage_products", next);
                }}
              />,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.price}
                onChange={(e) => {
                  const next = [...storageProducts];
                  next[i] = { ...p, price: Number(e.target.value) };
                  updateJson("storage_products", next);
                }}
              />,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.size / GB}
                onChange={(e) => {
                  const next = [...storageProducts];
                  next[i] = { ...p, size: Math.round(Number(e.target.value) * GB) };
                  updateJson("storage_products", next);
                }}
                InputProps={{ endAdornment: <InputAdornment position="end">GB</InputAdornment> }}
              />,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.duration}
                onChange={(e) => {
                  const next = [...storageProducts];
                  next[i] = { ...p, duration: Number(e.target.value) };
                  updateJson("storage_products", next);
                }}
              />,
              <IconButton
                size="small"
                onClick={() => updateJson("storage_products", storageProducts.filter((_, j) => j !== i))}
              >
                <Delete />
              </IconButton>,
            ])}
            empty={storageProducts.length === 0}
          />
          <NoMarginHelperText>有效期填 0 表示永久（购买后叠加到用户组容量上限之上）。</NoMarginHelperText>
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 用户组商品 ---------------- */}
      <SettingSection>
        <Typography variant="h6" gutterBottom>
          {t("settings.groupProductSettings")}
        </Typography>
        <SettingSectionContent>
          <Box sx={{ mb: 1 }}>
            <SecondaryButton
              variant="contained"
              startIcon={<Add />}
              onClick={() =>
                updateJson("group_sell_data", [
                  ...groupProducts,
                  {
                    id: "gp_" + Math.random().toString(36).slice(2, 8),
                    name: "新用户组商品",
                    price: 10,
                    group_id: groups[0]?.id ?? 0,
                    duration: 30,
                  },
                ])
              }
            >
              {t("settings.addGroupProduct")}
            </SecondaryButton>
          </Box>
          <ProductTable
            head={[t("settings.displayName"), t("settings.price"), "目标用户组", "有效期(天)", t("settings.actions")]}
            rows={groupProducts.map((p, i) => [
              <DenseFilledTextField
                fullWidth
                value={p.name}
                onChange={(e) => {
                  const next = [...groupProducts];
                  next[i] = { ...p, name: e.target.value };
                  updateJson("group_sell_data", next);
                }}
              />,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.price}
                onChange={(e) => {
                  const next = [...groupProducts];
                  next[i] = { ...p, price: Number(e.target.value) };
                  updateJson("group_sell_data", next);
                }}
              />,
              <TextField
                fullWidth
                size="small"
                select
                value={p.group_id}
                onChange={(e) => {
                  const next = [...groupProducts];
                  next[i] = { ...p, group_id: Number(e.target.value) };
                  updateJson("group_sell_data", next);
                }}
              >
                {groups.map((g) => (
                  <MenuItem key={g.id} value={g.id}>
                    {g.name} ({g.id})
                  </MenuItem>
                ))}
              </TextField>,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.duration}
                onChange={(e) => {
                  const next = [...groupProducts];
                  next[i] = { ...p, duration: Number(e.target.value) };
                  updateJson("group_sell_data", next);
                }}
              />,
              <IconButton
                size="small"
                onClick={() => updateJson("group_sell_data", groupProducts.filter((_, j) => j !== i))}
              >
                <Delete />
              </IconButton>,
            ])}
            empty={groupProducts.length === 0}
          />
          <NoMarginHelperText>到期后自动回退到购买前的用户组；有效期填 0 表示永久。</NoMarginHelperText>
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 积分商品 ---------------- */}
      <SettingSection>
        <Typography variant="h6" gutterBottom>
          积分商品
        </Typography>
        <SettingSectionContent>
          <Box sx={{ mb: 1 }}>
            <SecondaryButton
              variant="contained"
              startIcon={<Add />}
              onClick={() =>
                updateJson("credit_products", [
                  ...creditProducts,
                  { id: "cp_" + Math.random().toString(36).slice(2, 8), name: "新积分包", price: 10, credit: 1000 },
                ])
              }
            >
              添加积分商品
            </SecondaryButton>
          </Box>
          <ProductTable
            head={["名称", t("settings.price"), "积分", t("settings.actions")]}
            rows={creditProducts.map((p, i) => [
              <DenseFilledTextField
                fullWidth
                value={p.name}
                onChange={(e) => {
                  const next = [...creditProducts];
                  next[i] = { ...p, name: e.target.value };
                  updateJson("credit_products", next);
                }}
              />,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.price}
                onChange={(e) => {
                  const next = [...creditProducts];
                  next[i] = { ...p, price: Number(e.target.value) };
                  updateJson("credit_products", next);
                }}
              />,
              <DenseFilledTextField
                fullWidth
                type="number"
                value={p.credit}
                onChange={(e) => {
                  const next = [...creditProducts];
                  next[i] = { ...p, credit: Number(e.target.value) };
                  updateJson("credit_products", next);
                }}
              />,
              <IconButton
                size="small"
                onClick={() => updateJson("credit_products", creditProducts.filter((_, j) => j !== i))}
              >
                <Delete />
              </IconButton>,
            ])}
            empty={creditProducts.length === 0}
          />
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 礼品卡 ---------------- */}
      <SettingSection>
        <Typography variant="h6" gutterBottom>
          {t("giftCodes.giftCodesSettings")}
        </Typography>
        <SettingSectionContent>
          <Box sx={{ mb: 1 }}>
            <SecondaryButton variant="contained" startIcon={<Add />} onClick={() => setGiftDialog(true)}>
              批量生成
            </SecondaryButton>
          </Box>
          {lastCodes.length > 0 && (
            <DenseFilledTextField
              fullWidth
              multiline
              value={lastCodes.join("\n")}
              onFocus={(e) => e.currentTarget.select()}
              helperText="刚生成的卡密（已自动复制区：点击全选后 Ctrl+C）"
            />
          )}
          <ProductTable
            head={["卡密", "商品", "状态", "使用者", t("settings.actions")]}
            rows={giftCodes.map((g) => [
              g.code,
              g.product_payload?.name ?? g.product_type,
              <Chip size="small" color={g.used_by ? "default" : "success"} label={g.used_by ? "已使用" : "未使用"} />,
              g.used_by ?? "-",
              g.used_by ? <span /> : (
                <IconButton size="small" onClick={() => deleteGiftCode(g.id)}>
                  <Delete />
                </IconButton>
              ),
            ])}
            empty={giftCodes.length === 0}
          />
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 站点公告 / 新用户初始文件夹 ---------------- */}
      <SettingSection>
        <SettingSectionContent>
          <Stack spacing={2}>
            <TextField
              fullWidth
              multiline
              minRows={2}
              label="站点公告"
              placeholder="留空则不显示"
              value={text("announcement")}
              onChange={setText("announcement")}
            />
            <TextField
              fullWidth
              multiline
              minRows={2}
              label="新用户初始文件夹（JSON 数组）"
              placeholder='["我的文档","我的图片","我的视频"]'
              value={text("initial_files")}
              onChange={setText("initial_files")}
            />
            <Typography variant="caption" color="text.secondary">
              站点公告以纯文本展示在页面顶部横幅；初始文件夹需为合法 JSON 字符串数组，新用户注册时在其根目录创建。
            </Typography>
          </Stack>
        </SettingSectionContent>
      </SettingSection>

      {/* ---------------- 提供商编辑弹窗 ---------------- */}
      <Dialog open={!!providerDialog} onClose={() => setProviderDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>编辑支付提供商（易支付）</DialogTitle>
        <DialogContent>
          {providerDialog && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField
                fullWidth
                label="名称"
                value={providerDialog.value.name}
                onChange={(e) =>
                  setProviderDialog({ ...providerDialog, value: { ...providerDialog.value, name: e.target.value } })
                }
              />
              <TextField
                fullWidth
                label="网关地址"
                placeholder="https://pay.example.com"
                value={providerDialog.value.epay_url}
                onChange={(e) =>
                  setProviderDialog({ ...providerDialog, value: { ...providerDialog.value, epay_url: e.target.value } })
                }
              />
              <TextField
                fullWidth
                label="商户 ID (pid)"
                value={providerDialog.value.pid}
                onChange={(e) =>
                  setProviderDialog({ ...providerDialog, value: { ...providerDialog.value, pid: e.target.value } })
                }
              />
              <TextField
                fullWidth
                label="商户密钥 (key)"
                value={providerDialog.value.key}
                onChange={(e) =>
                  setProviderDialog({ ...providerDialog, value: { ...providerDialog.value, key: e.target.value } })
                }
              />
              <TextField
                fullWidth
                select
                label="支付渠道"
                value={providerDialog.value.channel}
                onChange={(e) =>
                  setProviderDialog({ ...providerDialog, value: { ...providerDialog.value, channel: e.target.value } })
                }
              >
                <MenuItem value="alipay">支付宝</MenuItem>
                <MenuItem value="wxpay">微信</MenuItem>
                <MenuItem value="qqpay">QQ 钱包</MenuItem>
              </TextField>
              <FormControlLabel
                control={
                  <Switch
                    checked={providerDialog.value.enabled}
                    onChange={(e) =>
                      setProviderDialog({
                        ...providerDialog,
                        value: { ...providerDialog.value, enabled: e.target.checked },
                      })
                    }
                  />
                }
                label="启用"
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProviderDialog(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (!providerDialog) return;
              const next = [...providers];
              if (providerDialog.index >= 0) next[providerDialog.index] = providerDialog.value;
              else next.push(providerDialog.value);
              updateJson("payment", next);
              setProviderDialog(null);
            }}
          >
            确定
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---------------- 礼品卡生成弹窗 ---------------- */}
      <Dialog open={giftDialog} onClose={() => setGiftDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>批量生成礼品卡</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              fullWidth
              select
              label="商品类型"
              value={giftForm.product_type}
              onChange={(e) =>
                setGiftForm({ ...giftForm, product_type: e.target.value as typeof giftForm.product_type })
              }
            >
              <MenuItem value="storage">容量</MenuItem>
              <MenuItem value="group">用户组</MenuItem>
              <MenuItem value="credit">积分</MenuItem>
            </TextField>
            <TextField
              fullWidth
              label="名称"
              value={giftForm.name}
              onChange={(e) => setGiftForm({ ...giftForm, name: e.target.value })}
            />
            <TextField
              fullWidth
              type="number"
              label="生成数量（≤200）"
              value={giftForm.count}
              onChange={(e) => setGiftForm({ ...giftForm, count: Number(e.target.value) })}
            />
            {giftForm.product_type === "storage" && (
              <>
                <TextField
                  fullWidth
                  type="number"
                  label="容量 (GB)"
                  value={giftForm.size_gb}
                  onChange={(e) => setGiftForm({ ...giftForm, size_gb: Number(e.target.value) })}
                />
                <TextField
                  fullWidth
                  type="number"
                  label="有效期(天，0=永久)"
                  value={giftForm.duration}
                  onChange={(e) => setGiftForm({ ...giftForm, duration: Number(e.target.value) })}
                />
              </>
            )}
            {giftForm.product_type === "group" && (
              <>
                <TextField
                  fullWidth
                  select
                  label="目标用户组"
                  value={giftForm.group_id}
                  onChange={(e) => setGiftForm({ ...giftForm, group_id: Number(e.target.value) })}
                >
                  {groups.map((g) => (
                    <MenuItem key={g.id} value={g.id}>
                      {g.name} ({g.id})
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  type="number"
                  label="有效期(天，0=永久)"
                  value={giftForm.duration}
                  onChange={(e) => setGiftForm({ ...giftForm, duration: Number(e.target.value) })}
                />
              </>
            )}
            {giftForm.product_type === "credit" && (
              <TextField
                fullWidth
                type="number"
                label="积分数量"
                value={giftForm.credit}
                onChange={(e) => setGiftForm({ ...giftForm, credit: Number(e.target.value) })}
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGiftDialog(false)}>取消</Button>
          <Button variant="contained" onClick={generateGiftCodes}>
            生成
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
};

/** 简易表格容器。 */
function ProductTable(props: { head: string[]; rows: React.ReactNode[][]; empty: boolean }) {
  return (
    <TableContainer component={StyledTableContainerPaper}>
      <Table size="small">
        <TableHead>
          <TableRow>
            {props.head.map((h) => (
              <TableCell key={h} sx={{ whiteSpace: "nowrap" }}>
                {h}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {props.empty ? (
            <TableRow>
              <TableCell colSpan={props.head.length} align="center">
                <Typography variant="caption" color="text.secondary">
                  暂无内容，保存后生效
                </Typography>
              </TableCell>
            </TableRow>
          ) : (
            props.rows.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j}>{cell}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** SettingSectionContent 的行包装（保持与官方设置页一致的纵向间距）。 */
function SettingRow(props: { children: React.ReactNode }) {
  return <Box sx={{ width: "100%" }}>{props.children}</Box>;
}

export default VAS;
