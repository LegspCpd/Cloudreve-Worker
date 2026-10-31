/**
 * 错误码表 —— 从 Cloudreve v4 的 `pkg/serializer/error.go` 逐字移植。
 *
 * 规则（原版注释）：
 *   三位数错误编码复用 HTTP 原含义；
 *   五位数错误码为应用自定义；五开头表示服务端错误，四开头表示客户端错误。
 *
 * 付费相关的四个码（CodePurchaseRequired / CodeInsufficientCredit /
 * CodeInvalidGiftCode / CodeAmountTooSmall）保留定义以免前端读到未知码，
 * 但后端不会有任何路径返回它们。
 */

export const CodeNotFullySuccess = 203;
export const CodeCheckLogin = 401;
export const CodeNoPermissionErr = 403;
export const CodeNotFound = 404;
export const CodeConflict = 409;

export const CodeUploadFailed = 40002;
export const CodeCreateFolderFailed = 40003;
export const CodeObjectExist = 40004;
export const CodeSignExpired = 40005;
export const CodePolicyNotAllowed = 40006;
export const CodeGroupNotAllowed = 40007;
export const CodeAdminRequired = 40008;
export const CodeMasterNotFound = 40009;
export const CodePhoneRequired = 40010;
export const CodeUploadSessionExpired = 40011;
export const CodeInvalidChunkIndex = 40012;
export const CodeInvalidContentLength = 40013;
export const CodeBatchSourceSize = 40014;
export const CodeBatchAria2Size = 40015;
export const CodeParentNotExist = 40016;
export const CodeUserBaned = 40017;
export const CodeUserNotActivated = 40018;
export const CodeFeatureNotEnabled = 40019;
export const CodeCredentialInvalid = 40020;
export const CodeUserNotFound = 40021;
export const Code2FACodeErr = 40022;
export const CodeLoginSessionNotExist = 40023;
export const CodeInitializeAuthn = 40024;
export const CodeWebAuthnCredentialError = 40025;
export const CodeCaptchaError = 40026;
export const CodeCaptchaRefreshNeeded = 40027;
export const CodeFailedSendEmail = 40028;
export const CodeInvalidTempLink = 40029;
export const CodeTempLinkExpired = 40030;

/**
 * 请求过于频繁（本地新增，上游没有对应码）。
 * 用于登录 / 2FA / 注册 / 找回密码 / 分享密码这些「猜口令」入口的限速，
 * 与 HTTP 的 429 语义一致；响应头同时带 `Retry-After`。
 * 取 40090 是为了不和上游 4xx 段冲突（上游目前到 40089）。
 */
export const CodeRateLimited = 40090;
export const CodeEmailProviderBaned = 40031;
export const CodeEmailExisted = 40032;
export const CodeEmailSent = 40033;
export const CodeUserCannotActivate = 40034;
export const CodePolicyNotExist = 40035;
export const CodeDeleteDefaultPolicy = 40036;
export const CodePolicyUsedByFiles = 40037;
export const CodePolicyUsedByGroups = 40038;
export const CodeGroupNotFound = 40039;
export const CodeInvalidActionOnSystemGroup = 40040;
export const CodeGroupUsedByUser = 40041;
export const CodeChangeGroupForDefaultUser = 40042;
export const CodeInvalidActionOnDefaultUser = 40043;
export const CodeFileNotFound = 40044;
export const CodeListFilesError = 40045;
export const CodeInvalidActionOnSystemNode = 40046;
export const CodeCreateFSError = 40047;
export const CodeCreateTaskError = 40048;
export const CodeFileTooLarge = 40049;
export const CodeFileTypeNotAllowed = 40050;
export const CodeInsufficientCapacity = 40051;
export const CodeIllegalObjectName = 40052;
export const CodeRootProtected = 40053;
export const CodeConflictUploadOngoing = 40054;
export const CodeMetaMismatch = 40055;
export const CodeUnsupportedArchiveType = 40056;
export const CodePolicyChanged = 40057;
export const CodeShareLinkNotFound = 40058;
export const CodeSaveOwnShare = 40059;
export const CodeSlavePingMaster = 40060;
export const CodeVersionMismatch = 40061;
export const CodeInsufficientCredit = 40062;
export const CodeGroupConflict = 40063;
export const CodeGroupInvalid = 40064;
export const CodeInvalidGiftCode = 40065;
export const CodeOpenIDBindConflict = 40066;
export const CodeOpenIDBindOtherAccount = 40067;
export const CodeOpenIDNotLinked = 40068;
export const CodeIncorrectPassword = 40069;
export const CodeDisabledSharePreview = 40070;
export const CodeInvalidSign = 40071;
export const CodeFulfillAdminGroup = 40072;
export const CodeLockConflict = 40073;
export const CodeTooManyUris = 40074;
export const CodeLockExpired = 40075;
export const CodeStaleVersion = 40076;
export const CodeEntityNotExist = 40077;
export const CodeFileDeleted = 40078;
export const CodeFileCountLimitedReached = 40079;
export const CodeInvalidPassword = 40080;
export const CodeBatchOperationNotFullyCompleted = 40081;
export const CodeOwnerOnly = 40082;
export const CodePurchaseRequired = 40083;
export const CodeManagedAccountMinimumOpenID = 40084;
export const CodeAmountTooSmall = 40085;
export const CodeNodeUsedByStoragePolicy = 40086;
export const CodeDomainNotLicensed = 40087;
export const CodeAnonymouseAccessDenied = 40088;
export const CodeInsufficientScope = 40089;

export const CodeDBError = 50001;
export const CodeEncryptError = 50002;
export const CodeIOFailed = 50004;
export const CodeInternalSetting = 50005;
export const CodeCacheOperation = 50006;
export const CodeCallbackError = 50007;
export const CodeUpdateSetting = 50008;
export const CodeAddCORS = 50009;
export const CodeNodeOffline = 50010;
export const CodeQueryMetaFailed = 50011;

export const CodeParamErr = 40001;
export const CodeNotSet = -1;

/** 应用错误。与原版 `serializer.AppError` 对应。 */
export class AppError extends Error {
  constructor(
    public code: number,
    public msg: string,
    public raw?: unknown,
  ) {
    super(msg);
    this.name = 'AppError';
  }
}

/**
 * Range 请求越界。
 *
 * 单独成类而不是只抛一个 `AppError`：这需要 HTTP 416 + `Content-Range: bytes * /总长`，
 * 而不是本站统一的「HTTP 200 + 业务码」信封。播放器/下载器靠 416 判断
 * 「这段没有」，拿到 200 会一直重试。
 */
export class RangeNotSatisfiable extends AppError {
  constructor(public readonly totalSize: number) {
    super(CodeParamErr, 'Requested range not satisfiable', { totalSize });
    this.name = 'RangeNotSatisfiable';
  }
}

/**
 * 构造 AppError 的语法糖。
 * `newError(CodeFileNotFound, 'File not found')`
 */
export function newError(code: number, msg: string, raw?: unknown): AppError {
  return new AppError(code, msg, raw);
}

/** 把任意抛出的值整理成带完整上下文的字符串，专治没有 message 的错误对象。 */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause !== undefined ? ` | cause: ${describeError(e.cause)}` : '';
    const extra = Object.getOwnPropertyNames(e)
      .filter((k) => !['stack', 'message', 'cause'].includes(k))
      .map((k) => `${k}=${JSON.stringify((e as unknown as Record<string, unknown>)[k])}`)
      .join(', ');
    return `${e.name}: ${e.message || '(no message)'}${extra ? ` | ${extra}` : ''}${cause}\n${e.stack ?? ''}`;
  }
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** 常用错误的快捷构造，消息文案与原版保持一致（前端可能按 msg 做展示）。 */
export const Err = {
  param: (msg = 'Invalid parameters.') => new AppError(CodeParamErr, msg),
  loginRequired: () => new AppError(CodeCheckLogin, 'Unauthorized action'),
  noPermission: () => new AppError(CodeNoPermissionErr, 'Unauthorized action'),
  notFound: (msg = 'Not found') => new AppError(CodeNotFound, msg),
  fileNotFound: () => new AppError(CodeFileNotFound, 'File not found'),
  userNotFound: () => new AppError(CodeUserNotFound, 'User not found'),
  incorrectPassword: () => new AppError(CodeIncorrectPassword, 'Incorrect password'),
  objectExist: () => new AppError(CodeObjectExist, 'Object existed'),
  capacity: () => new AppError(CodeInsufficientCapacity, 'Insufficient capacity'),
  shareNotFound: () => new AppError(CodeShareLinkNotFound, 'Share link not found'),
  rootProtected: () => new AppError(CodeRootProtected, 'Cannot operate on root folder'),
  illegalName: (msg = 'Illegal object name') => new AppError(CodeIllegalObjectName, msg),
  db: (raw?: unknown, msg = 'Database operation failed.') => new AppError(CodeDBError, msg, raw),
  internal: (raw?: unknown, msg = 'Internal error') => new AppError(CodeInternalSetting, msg, raw),
  featureNotEnabled: (msg = 'This feature is not enabled') =>
    new AppError(CodeFeatureNotEnabled, msg),
  policyNotAllowed: () => new AppError(CodePolicyNotAllowed, 'Storage policy not allowed'),
  groupNotAllowed: () => new AppError(CodeGroupNotAllowed, 'Group not allowed'),
  adminRequired: () => new AppError(CodeAdminRequired, 'Admin required'),
  scopeInsufficient: (scope: string) =>
    new AppError(CodeInsufficientScope, `Insufficient scope: ${scope}`),
  /**
   * 符号目录（保存到我的网盘的分享快捷方式）不能走进去。
   * 文案取自原版 `dbfs.ErrSymbolicFolderFound`（navigator.go:28）。
   */
  symbolicFolder: () =>
    new AppError(CodeNoPermissionErr, 'Symbolic folder cannot be walked into'),
};
