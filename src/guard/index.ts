// Every check at the edge of the box, in one place: input parsing, static paths, limits and proxy trust, what the public
// sees, containment of model output and of sayso's reason, the admin gate and what logs may say. server.ts, agent.ts,
// wallet.ts and main.ts call into this and hold no checks of their own.
export { AdminGate, tokenOk, type AdminRefusal } from './admin.ts'
export { PUBLIC_FIELDS, publicAttempt, type PublicAttempt } from './expose.ts'
export {
  BodyRefused, boundedInt, cleanHandle, cleanText, FEED_PAGE, MAX_BODY, MAX_TEXT_CHARS, parseAdminHide, parseAdminPause, parseFeedQuery,
  parseSubmit, readJson, vendorHandles, type AdminHide, type AdminPause, type FeedQuery, type Parsed, type Submit,
} from './input.ts'
export {
  clientIp, hardenServer, ipKey, isLoopback, Limits, MAX_CONNECTIONS, proxyTrustProblem, RateWindow, SharedRead, unmapIp, WindowLimiter,
  type Admission, type LimitConfig,
} from './limits.ts'
export { errorTag } from './log.ts'
export { checkDecision, cleanModelText, MODEL_TEXT, type Checked } from './model.ts'
export { staticPath } from './static.ts'
export { slug } from './text.ts'
