/** One desktop geometry policy for saved profiles, imports and native views. */
import type { Profile } from "../types.ts";

export const DESKTOP_SCREEN_LIMITS = Object.freeze({ minWidth: 1024, maxWidth: 4096, minHeight: 640, maxHeight: 2160, maxPixels: 4096 * 2160 });
export interface DesktopScreen { width: number; height: number; }
/** Phone/tablet viewport for "native app" profiles. Chromium only; the saved
 * desktop identity is unchanged, the live page is emulated at this size with touch. */
export const MOBILE_VIEW_LIMITS = Object.freeze({ minWidth: 320, maxWidth: 1024, minHeight: 480, maxHeight: 2160 });
export const MOBILE_VIEW_PRESETS = Object.freeze([
  { id: "iphone-15", label: "iPhone 15 / 14", width: 393, height: 852 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "galaxy-s23", label: "Galaxy S23", width: 360, height: 780 },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024 },
]);
export function validateMobileView(value: unknown): DesktopScreen {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mobile view requires width and height");
  const view = value as Record<string, unknown>;
  if (Object.keys(view).some(key => key !== "width" && key !== "height")
    || !Number.isSafeInteger(view.width) || !Number.isSafeInteger(view.height)
    || Number(view.width) < MOBILE_VIEW_LIMITS.minWidth || Number(view.width) > MOBILE_VIEW_LIMITS.maxWidth
    || Number(view.height) < MOBILE_VIEW_LIMITS.minHeight || Number(view.height) > MOBILE_VIEW_LIMITS.maxHeight) {
    throw new Error("Mobile view must use integer width 320–1024 and height 480–2160 pixels");
  }
  return { width: view.width as number, height: view.height as number };
}

export function validateDesktopScreen(value: unknown): DesktopScreen {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop screen requires width and height");
  const screen = value as Record<string, unknown>;
  if (Object.keys(screen).some(key => key !== "width" && key !== "height")
    || !Number.isSafeInteger(screen.width) || !Number.isSafeInteger(screen.height)
    || Number(screen.width) < DESKTOP_SCREEN_LIMITS.minWidth || Number(screen.width) > DESKTOP_SCREEN_LIMITS.maxWidth
    || Number(screen.height) < DESKTOP_SCREEN_LIMITS.minHeight || Number(screen.height) > DESKTOP_SCREEN_LIMITS.maxHeight
    || Number(screen.width) * Number(screen.height) > DESKTOP_SCREEN_LIMITS.maxPixels) {
    throw new Error("Desktop screen must use integer width 1024–4096 and height 640–2160 pixels");
  }
  return { width: screen.width as number, height: screen.height as number };
}

export function parseDesktopResolution(value: unknown): DesktopScreen {
  if (typeof value !== "string") return validateDesktopScreen(value);
  if (value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Desktop resolution is invalid");
  const match = /^\s*(\d{3,4})\s*[xX*]\s*(\d{3,4})\s*$/.exec(value);
  if (!match) throw new Error("Desktop resolution must contain width x height");
  return validateDesktopScreen({ width: Number(match[1]), height: Number(match[2]) });
}

/** Launch is read-only: legacy geometry and mobile identities require an
 * explicit stopped edit or a fresh desktop configuration copy. */
export function validateDesktopProfile(profile: Profile): DesktopScreen {
  const screen = validateDesktopScreen({ width: profile.screenWidth, height: profile.screenHeight });
  const userAgents = [profile.ua, profile.firefox?.config["navigator.userAgent"]];
  if (userAgents.some(value => typeof value === "string" && /Mobile|Android|iPhone|iPad|iPod/i.test(value))) {
    throw new Error("This saved profile uses a mobile identity; create a fresh desktop configuration copy before starting");
  }
  if (profile.engine === "firefox") {
    const config = profile.firefox?.config;
    const expected = { "screen.width": screen.width, "screen.height": screen.height, "screen.availWidth": screen.width, "screen.availHeight": screen.height,
      "window.innerWidth": screen.width, "window.innerHeight": screen.height, "window.outerWidth": screen.width, "window.outerHeight": screen.height };
    if (!config || Object.entries(expected).some(([key, value]) => config[key] !== value)
      || ["window.screenX", "window.screenY", "screen.availLeft", "screen.availTop"].some(key => Object.hasOwn(config, key) && config[key] !== 0)) {
      throw new Error("Saved Firefox desktop geometry differs; save its screen dimensions while stopped before starting");
    }
  }
  return screen;
}

/** Explicit creation/stopped-edit boundary; never regenerate identity inputs. */
export function withDesktopScreen(profile: Profile, value: DesktopScreen): Profile {
  const { width, height } = validateDesktopScreen(value);
  if (profile.engine !== "firefox") return { ...profile, screenWidth: width, screenHeight: height };
  if (!profile.firefox) throw new Error("Firefox profile is missing its saved configuration");
  const origin = Object.fromEntries(["window.screenX", "window.screenY", "screen.availLeft", "screen.availTop"]
    .filter(key => Object.hasOwn(profile.firefox!.config, key)).map(key => [key, 0]));
  return { ...profile, screenWidth: width, screenHeight: height, firefox: { ...profile.firefox, config: {
    ...profile.firefox.config,
    ...origin,
    "screen.width": width, "screen.height": height, "screen.availWidth": width, "screen.availHeight": height,
    "window.innerWidth": width, "window.innerHeight": height, "window.outerWidth": width, "window.outerHeight": height,
  } } };
}
