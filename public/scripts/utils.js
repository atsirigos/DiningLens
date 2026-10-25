export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = '0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

export async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }

  return res.json();
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

export function parseFilenameDate(filename) {
  const match = filename.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
}

const FRIENDLY_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FRIENDLY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Monday, Sep 7, 7:45pm" */
export function formatFriendlyDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  return `${FRIENDLY_WEEKDAYS[date.getDay()]}, ${FRIENDLY_MONTHS[date.getMonth()]} ${date.getDate()}, ${hours}:${minutes}${ampm}`;
}

export function parseSessionStart(session) {
  const match = String(session || '').match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Interval stills saved as a recording session, as opposed to a video meal. */
export function isFrameRecording(item) {
  if (!item || item.type !== 'recording') return false;
  if (item.mode === 'video') return false;
  if (!item.frames?.length && item.videos?.length) return false;
  return true;
}

/** Gallery and Processing share this meal title. */
export function mealLabel(file) {
  const fromSession = parseSessionStart(file?.session);
  let date = fromSession;
  if (!date) {
    const captured = file?.videos?.[0]?.capturedAt
      || file?.frames?.[0]?.modified
      || file?.capturedAt
      || file?.modified;
    const parsed = new Date(captured);
    date = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return formatFriendlyDateTime(date) || file?.name || '';
}
