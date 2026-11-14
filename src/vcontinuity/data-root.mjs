import path from "node:path";
import { fileURLToPath } from "node:url";

export const dataRoot = process.env.VCONTINUITY_DATA_ROOT
  ? path.resolve(process.env.VCONTINUITY_DATA_ROOT)
  : fileURLToPath(new URL("../../data/", import.meta.url));
