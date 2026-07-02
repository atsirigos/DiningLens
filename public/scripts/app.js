const loadedModules = {};

const TAB_MODULES = {
  settings: () => import('./settings.js'),
  phone: () => import('./phone.js'),
  recording: () => import('./recording.js'),
  zones: () => import('./zones.js'),
  gallery: () => import('./gallery.js'),
  trash: () => import('./trash.js'),
  processing: () => import('./processing.js'),
  analytics: () => import('./analytics.js'),
};

let activeTab = 'settings';

async function cleanupTab(tabName) {
  if (tabName !== 'phone') return;
  try {
    const mod = await TAB_MODULES.phone();
    if (mod.destroy) mod.destroy();
  } catch {
    /* ignore cleanup errors */
  }
}

function switchTab(tabName) {
  if (tabName !== activeTab) {
    cleanupTab(activeTab);
    activeTab = tabName;
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });

  if (!loadedModules[tabName]) {
    loadedModules[tabName] = true;
    TAB_MODULES[tabName]().then((mod) => {
      if (mod.init) mod.init();
    }).catch((err) => {
      console.error(`Failed to load ${tabName} module:`, err);
    });
  } else {
    TAB_MODULES[tabName]().then((mod) => {
      if (mod.refresh) mod.refresh();
    });
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

loadedModules.settings = true;
import('./settings.js').then((mod) => {
  if (mod.init) mod.init();
});
