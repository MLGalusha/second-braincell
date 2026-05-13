import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_URL = process.env.CHATGPT_PROJECT_URL || "";

export const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
export const OUTPUT_DIR = resolve(ROOT_DIR, "output");
export const JOBS_DIR = resolve(OUTPUT_DIR, "jobs");
export const IMAGES_DIR = resolve(OUTPUT_DIR, "images");
