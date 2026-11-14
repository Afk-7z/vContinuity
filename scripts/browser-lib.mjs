import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

async function fileExists(target) {
  if (!target) return false;
  try {
    const st = await fs.stat(target);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function resolveBrowserLaunchOptions() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    const custom = path.resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    if (await fileExists(custom)) {
      return { headless: true, executablePath: custom, source: "env" };
    }
    throw new Error("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH not found: " + custom);
  }

  try {
    const defaultExe = chromium.executablePath();
    if (defaultExe && await fileExists(defaultExe)) {
      return { headless: true, executablePath: defaultExe, source: "playwright-default" };
    }
  } catch {}

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(localAppData, "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);

  for (const root of cacheRoots) {
    let entries = [];
    try {
      entries = (await fs.readdir(root)).sort().reverse();
    } catch {
      continue;
    }
    const shellDirs = entries.filter((name) => /^chromium_headless_shell-/.test(name));
    for (const dir of shellDirs) {
      const winExe = path.join(root, dir, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
      if (await fileExists(winExe)) return { headless: true, executablePath: winExe, source: "ms-playwright-cache" };
      const linuxExe = path.join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (await fileExists(linuxExe)) return { headless: true, executablePath: linuxExe, source: "ms-playwright-cache" };
    }
    const fullDirs = entries.filter((name) => /^chromium-/.test(name));
    for (const dir of fullDirs) {
      const winExe = path.join(root, dir, "chrome-win64", "chrome.exe");
      if (await fileExists(winExe)) return { headless: true, executablePath: winExe, source: "ms-playwright-cache" };
      const linuxExe = path.join(root, dir, "chrome-linux64", "chrome");
      if (await fileExists(linuxExe)) return { headless: true, executablePath: linuxExe, source: "ms-playwright-cache" };
    }
  }

  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "";
    const pf86 = process.env["ProgramFiles(x86)"] || "";
    const systemPaths = [
      pf && path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      pf86 && path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      pf && path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      pf86 && path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
    for (const exe of systemPaths) {
      if (await fileExists(exe)) return { headless: true, executablePath: exe, source: "system-browser" };
    }
  }

  if (process.platform === "linux") {
    for (const exe of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await fileExists(exe)) return { headless: true, executablePath: exe, source: "system-browser" };
    }
  }

  throw new Error(
    "No Chromium/Chrome/Edge browser executable found for Playwright. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or run 'npx playwright-core install chromium'.",
  );
}

export async function launchTestBrowser() {
  const { source, ...launchOptions } = await resolveBrowserLaunchOptions();
  const browser = await chromium.launch({
    ...launchOptions,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return { browser, source };
}
