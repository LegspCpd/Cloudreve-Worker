import {
  Box,
  Button,
  DialogContent,
  FormControlLabel,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sendUpdateDirectLinkSlug } from "../../../../api/api.ts";
import { useTranslation } from "react-i18next";
import { DirectLink } from "../../../../api/explorer.ts";
import { closeDirectLinkDialog } from "../../../../redux/globalStateSlice.ts";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks.ts";
import CrUri from "../../../../util/uri.ts";
import { NoLabelFilledTextField, StyledCheckbox } from "../../../Common/StyledComponents.tsx";
import DraggableDialog from "../../../Dialogs/DraggableDialog.tsx";
import AppsList from "../../../Icons/AppsList.tsx";
import SlideText from "../../../Icons/SlideText.tsx";
import DirectLinkItem from "./DirectLinkItem.tsx";

type ViewMode = "list" | "text";

const DirectLinks = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [showFileName, setShowFileName] = useState(false);
  const [forceDownload, setForceDownload] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  // 自定义短码：只对单文件生效。留空提交=让服务端重新随机生成。
  const [customSlug, setCustomSlug] = useState("");
  const [slugSaving, setSlugSaving] = useState(false);
  // 改完短码后本地立即生效（redux 里的 targets 不会自动刷新）
  const [overrideSlug, setOverrideSlug] = useState("");

  const open = useAppSelector((state) => state.globalState.directLinkDialogOpen);
  const targets = useAppSelector((state) => state.globalState.directLinkRes);
  const dispatchTyped = useAppDispatch();

  const relativePathPlaceholder = t("application:modals.relativePathPlaceholder");

  // 优先显示短链 /d/<slug>：固定前缀 + 随机码，不暴露文件名和目录。
  // 老直链没有 short_link 时回退到原 /f/ 形式（含强制下载开关）。
  const getDisplayLink = useCallback(
    (target: DirectLink) => {
      if (overrideSlug) return `${window.location.origin}/d/${overrideSlug}`;
      if (target.short_link) return target.short_link;
      if (forceDownload) return target.link.replace("/f/", "/f/d/");
      return target.link;
    },
    [forceDownload, overrideSlug],
  );

  const applySlug = useCallback(async () => {
    const target = targets?.[0];
    if (!target?.id || slugSaving) return;
    setSlugSaving(true);
    try {
      const res: any = await dispatchTyped(sendUpdateDirectLinkSlug(target.id, customSlug));
      setOverrideSlug(res?.slug ?? customSlug);
    } finally {
      setSlugSaving(false);
    }
  }, [targets, customSlug, slugSaving, dispatchTyped]);

  // 打开对话框时把当前短码填进输入框，方便基于随机码改
  useEffect(() => {
    if (open) {
      setCustomSlug(targets?.[0]?.slug ?? "");
      setOverrideSlug("");
    }
  }, [open, targets]);

  const getDisplayName = useCallback((fileUrl: string) => {
    const crUri = new CrUri(fileUrl);
    const elements = crUri.elements();
    return elements.pop() ?? "";
  }, []);

  const textContents = useMemo(() => {
    if (!targets) return "";
    return targets
      .map((target) => {
        const finalLink = getDisplayLink(target);
        if (!showFileName) return `${finalLink}`;
        return `[${getDisplayName(target.file_url)}] ${finalLink}`;
      })
      .join("\n");
  }, [targets, showFileName, getDisplayLink, getDisplayName, relativePathPlaceholder]);

  const onClose = useCallback(() => {
    dispatch(closeDirectLinkDialog());
  }, [dispatch]);

  const handleViewModeChange = useCallback((_: React.MouseEvent, newMode: ViewMode | null) => {
    if (newMode !== null) {
      setViewMode(newMode);
    }
  }, []);

  return (
    <DraggableDialog
      title={t("application:modals.getSourceLinkTitle")}
      showActions
      hideOk
      secondaryAction={
        <Stack direction={isMobile ? "column" : "row"} spacing={1}>
          <FormControlLabel
            sx={{ ml: 0 }}
            slotProps={{
              typography: { variant: "body2", pl: 1, color: "text.secondary" },
            }}
            control={
              <StyledCheckbox
                onChange={() => setShowFileName(!showFileName)}
                disableRipple
                checked={showFileName}
                size="small"
              />
            }
            label={t("application:modals.showFileName")}
          />
          <FormControlLabel
            sx={{ ml: 0 }}
            slotProps={{
              typography: { variant: "body2", pl: 1, color: "text.secondary" },
            }}
            control={
              <StyledCheckbox
                onChange={() => setForceDownload(!forceDownload)}
                disableRipple
                checked={forceDownload}
                size="small"
              />
            }
            label={t("application:modals.forceDownload")}
          />
        </Stack>
      }
      dialogProps={{
        open: open ?? false,
        onClose: onClose,
        fullWidth: true,
        maxWidth: "sm",
      }}
    >
      <DialogContent sx={{ pt: 0, pb: 0 }}>
        {/* 单文件才允许自定义短码：留空=随机，填了=自定义；改完立即生效 */}
        {(targets?.length ?? 0) === 1 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <NoLabelFilledTextField
                fullWidth
                size="small"
                value={customSlug}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomSlug(e.target.value)}
                placeholder={"自定义短码（留空为随机）"}
                slotProps={{ htmlInput: { maxLength: 64 } }}
              />
            </Box>
            <Button
              size="small"
              variant="outlined"
              disabled={slugSaving}
              onClick={applySlug}
            >
              {"应用"}
            </Button>
          </Stack>
        )}
        {(targets?.length ?? 0) > 1 && (
          <ToggleButtonGroup value={viewMode} exclusive onChange={handleViewModeChange} sx={{ mb: 1 }} size="small">
            <ToggleButton value="list">
              <AppsList fontSize="small" sx={{ mr: 0.5 }} />
              <Typography variant="caption">{t("application:fileManager.listView")}</Typography>
            </ToggleButton>
            <ToggleButton value="text">
              <SlideText fontSize="small" sx={{ mr: 0.5 }} />
              <Typography variant="caption">{t("application:modals.textView")}</Typography>
            </ToggleButton>
          </ToggleButtonGroup>
        )}

        {viewMode === "list" ? (
          <DirectLinkList
            targets={targets}
            showFileName={showFileName}
            getDisplayLink={getDisplayLink}
            getDisplayName={getDisplayName}
            relativePathPlaceholder={relativePathPlaceholder}
          />
        ) : (
          <NoLabelFilledTextField
            autoFocus
            fullSize
            multiline
            value={textContents}
            variant="outlined"
            fullWidth
            slotProps={{
              htmlInput: { readOnly: true },
            }}
          />
        )}
      </DialogContent>
    </DraggableDialog>
  );
};

interface DirectLinkListProps {
  targets?: DirectLink[];
  showFileName: boolean;
  getDisplayLink: (target: DirectLink) => string;
  getDisplayName: (fileUrl: string) => string;
  relativePathPlaceholder: string;
}

const DirectLinkList = ({
  targets,
  showFileName,
  getDisplayLink,
  getDisplayName,
  relativePathPlaceholder,
}: DirectLinkListProps) => {
  return (
    <Box sx={{ maxHeight: 400, overflow: "auto" }}>
      <Stack spacing={0.5}>
        {targets?.map((target, index) => (
          <DirectLinkItem
            key={index}
            target={target}
            showDisplayName={showFileName}
            index={index}
            displayLink={getDisplayLink(target)}
            displayName={getDisplayName(target.file_url)}
            relativePathPlaceholder={relativePathPlaceholder}
          />
        ))}
      </Stack>
    </Box>
  );
};

export default DirectLinks;
