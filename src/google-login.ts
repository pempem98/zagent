/** One-time Google sign-in for Drive access: `npm run google-login`. */
import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import { DRIVE_READONLY_SCOPE, GoogleAuth } from "./google/auth.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const { google } = loadConfig();
if (!google) {
  console.error("Thiếu GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET trong .env (xem README, mục Google Drive).");
  process.exit(1);
}

const auth = new GoogleAuth(google);
try {
  await auth.login([DRIVE_READONLY_SCOPE], (url) => {
    console.log(`Mở đường dẫn sau trong trình duyệt để đăng nhập Google:\n\n${url}\n`);
    // Best effort; the printed URL is the fallback.
    const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(opener, () => {});
  });
  console.log(`Đăng nhập thành công. Đã lưu vào ${google.tokenFile}. Khởi động lại bot để đồng bộ Google Drive.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
