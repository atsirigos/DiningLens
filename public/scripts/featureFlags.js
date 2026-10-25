let frameRecordingsEnabled = false;

export function isFrameRecordingsEnabled() {
  return frameRecordingsEnabled;
}

function setText(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
}

/** Sidebar and panel titles follow the video-only default until the user opts in. */
function applyCaptureChrome() {
  const enabled = frameRecordingsEnabled;
  setText(
    '.nav-item[data-tab="zones"] .nav-label',
    enabled ? 'Zones' : 'Video Zones',
  );
  setText(
    '#panel-zones .panel-header h2',
    enabled ? 'Zones' : 'Video Zones',
  );

  const zonesEditorOpen = Boolean(document.getElementById('ref-media-select'));
  if (!zonesEditorOpen) {
    setText(
      '#panel-zones .panel-header p',
      enabled
        ? 'Define photo or video zones on a reference capture — each modality has its own layout'
        : 'Define zones on a reference video frame — the same layout applies to every video from this camera',
    );
  }

  setText(
    '#panel-recording .panel-header p',
    enabled
      ? 'Capture video or interval photo frames from your connected phone'
      : 'Record video from your connected phone',
  );
}

export function applySettingsFlags(settings) {
  frameRecordingsEnabled = settings?.frameRecordingsEnabled === true;
  document.documentElement.classList.toggle('frame-recordings-enabled', frameRecordingsEnabled);
  applyCaptureChrome();
}
