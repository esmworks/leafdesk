/** Whether this browser can share a tab's or screen's sound (Chromium's browsers; others share no audio, nor does the desktop app). */
export const canRecordOthers = () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Electron\//.test(navigator.userAgent);
