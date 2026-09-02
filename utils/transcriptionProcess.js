const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "PYTHONPATH",
  "DEEPGRAM_API_KEY",
  "GI_TYPELIB_PATH",
  "GST_PLUGIN_SCANNER",
  "GST_PLUGIN_PATH",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "PKG_CONFIG_PATH",
];

export function getTranscriptionProcessEnv(source = process.env) {
  const env = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (source[key]) env[key] = source[key];
  }

  if (process.platform === "darwin") {
    env.GI_TYPELIB_PATH ||= "/opt/homebrew/lib/girepository-1.0";
    env.GST_PLUGIN_SCANNER ||= "/opt/homebrew/libexec/gstreamer-1.0/gst-plugin-scanner";
    env.GST_PLUGIN_PATH ||= "/opt/homebrew/lib/gstreamer-1.0";
    env.DYLD_LIBRARY_PATH ||= "/opt/homebrew/lib";
    env.LD_LIBRARY_PATH ||= "/opt/homebrew/lib";
    env.PKG_CONFIG_PATH ||= "/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig";
  }

  return env;
}
