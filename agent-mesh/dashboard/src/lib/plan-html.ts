import DOMPurify from "dompurify"
import { createPlanSanitizer } from "./plan-sanitizer.ts"

export const sanitizePlanHtml = createPlanSanitizer(DOMPurify)
