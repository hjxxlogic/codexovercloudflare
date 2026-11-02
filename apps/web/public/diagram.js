/* global window, parent, document, mermaid, TextEncoder */
// Opaque sandbox: no application DOM, cookies, storage, or network access.
let initialized = false;
const viewport = document.getElementById('diagram-viewport');
const scene = document.getElementById('diagram');
let scale = 1,
  panX = 0,
  panY = 0,
  fitted = true,
  drag;
function expanded() {
  return document.documentElement.dataset.expanded === 'true';
}
function dimensions() {
  return scene.querySelector('svg')?.viewBox.baseVal;
}
function paint() {
  const size = dimensions();
  if (!size || !expanded()) return;
  scene.style.width = size.width + 'px';
  scene.style.height = size.height + 'px';
  scene.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  viewport.dataset.scale = String(scale);
  viewport.dataset.panX = String(panX);
  viewport.dataset.panY = String(panY);
  document.getElementById('zoom-level').textContent =
    Math.round(scale * 1000) / 10 + '%';
}
function fit() {
  const size = dimensions();
  if (!size?.width || !size.height || !expanded()) return;
  fitted = true;
  scale = Math.max(
    0.001,
    Math.min(
      4,
      (viewport.clientWidth - 32) / size.width,
      (viewport.clientHeight - 32) / size.height,
    ),
  );
  panX = (viewport.clientWidth - size.width * scale) / 2;
  panY = (viewport.clientHeight - size.height * scale) / 2;
  paint();
}
function zoom(
  factor,
  x = viewport.clientWidth / 2,
  y = viewport.clientHeight / 2,
) {
  if (!expanded()) return;
  const next = Math.max(0.001, Math.min(16, scale * factor));
  panX = x - ((x - panX) * next) / scale;
  panY = y - ((y - panY) * next) / scale;
  scale = next;
  fitted = false;
  paint();
}
function reset() {
  const size = dimensions();
  if (!size || !expanded()) return;
  scale = 1;
  panX = (viewport.clientWidth - size.width) / 2;
  panY = (viewport.clientHeight - size.height) / 2;
  fitted = false;
  paint();
}
function labels(language) {
  const english = language === 'en';
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  for (const [id, chinese, translation] of [
    ['zoom-out', '缩小', 'Zoom out'],
    ['zoom-in', '放大', 'Zoom in'],
    ['zoom-fit', '适应窗口', 'Fit to window'],
    ['zoom-reset', '100%', '100%'],
  ])
    document.getElementById(id).textContent = english ? translation : chinese;
  viewport.setAttribute(
    'aria-label',
    english ? 'Interactive diagram' : '可缩放图表',
  );
  document
    .getElementById('diagram-tools')
    .setAttribute('aria-label', english ? 'Diagram controls' : '图表操作');
  document
    .getElementById('zoom-level')
    .setAttribute('aria-label', english ? 'Zoom level' : '缩放比例');
}
function measureDiagram() {
  if (expanded()) return;
  const svg = scene.querySelector('svg');
  if (!svg) return;
  parent.postMessage(
    {
      type: 'cw-diagram-size',
      width: svg.viewBox.baseVal.width,
      renderedHeight: svg.getBoundingClientRect().height,
    },
    '*',
  );
}
function layout(value, language) {
  labels(language);
  const changed = expanded() !== (value === true);
  document.documentElement.dataset.expanded = value === true ? 'true' : 'false';
  if (expanded()) {
    if (changed) fit();
  } else {
    scene.style.width = '';
    scene.style.height = '';
    scene.style.transform = '';
    measureDiagram();
  }
}
document.getElementById('zoom-in').addEventListener('click', () => zoom(1.25));
document.getElementById('zoom-out').addEventListener('click', () => zoom(0.8));
document.getElementById('zoom-fit').addEventListener('click', fit);
document.getElementById('zoom-reset').addEventListener('click', reset);
viewport.addEventListener(
  'wheel',
  (event) => {
    if (!expanded()) return;
    event.preventDefault();
    const box = viewport.getBoundingClientRect();
    zoom(
      Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * 0.002),
      event.clientX - box.left,
      event.clientY - box.top,
    );
  },
  { passive: false },
);
viewport.addEventListener('pointerdown', (event) => {
  if (!expanded() || event.button !== 0) return;
  event.preventDefault();
  viewport.focus();
  viewport.setPointerCapture(event.pointerId);
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX,
    panY,
  };
  viewport.dataset.dragging = 'true';
});
viewport.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id || !expanded()) return;
  panX = drag.panX + event.clientX - drag.x;
  panY = drag.panY + event.clientY - drag.y;
  fitted = false;
  paint();
});
function release(event) {
  if (drag?.id !== event.pointerId) return;
  drag = undefined;
  delete viewport.dataset.dragging;
}
viewport.addEventListener('pointerup', release);
viewport.addEventListener('pointercancel', release);
viewport.addEventListener('lostpointercapture', release);
viewport.addEventListener('dblclick', () => {
  if (expanded()) fit();
});
window.addEventListener('resize', () => {
  if (expanded() && fitted) fit();
  else measureDiagram();
});
window.addEventListener('keydown', (event) => {
  if (expanded() && event.key === 'Tab') {
    const buttons = [
      ...document.querySelectorAll('#diagram-tools button'),
      viewport,
    ];
    const index = buttons.indexOf(document.activeElement);
    if (
      (event.shiftKey && index === 0) ||
      (!event.shiftKey && index === buttons.length - 1)
    ) {
      event.preventDefault();
      (event.shiftKey ? buttons.at(-1) : buttons[0]).focus();
    }
  }
  if (event.key === 'Escape')
    parent.postMessage({ type: 'cw-fullscreen-escape' }, '*');
  if (
    !expanded() ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing
  )
    return;
  if (
    [
      '+',
      '=',
      '-',
      '0',
      'Home',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
    ].includes(event.key)
  ) {
    event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-') zoom(0.8);
    else if (event.key === '0') reset();
    else if (event.key === 'Home') fit();
    else {
      const step = event.shiftKey ? 128 : 32;
      panX +=
        event.key === 'ArrowLeft'
          ? step
          : event.key === 'ArrowRight'
            ? -step
            : 0;
      panY +=
        event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
      fitted = false;
      paint();
    }
  }
});
window.addEventListener('message', async (event) => {
  if (event.source !== parent) return;
  if (event.data?.type === 'cw-diagram-layout') {
    layout(event.data.expanded, event.data.language);
    return;
  }
  if (
    event.source !== parent ||
    initialized ||
    event.data?.type !== 'cw-diagram'
  )
    return;
  initialized = true;
  const source = event.data.source;
  const theme = event.data.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  layout(event.data.expanded, event.data.language);
  const element = document.getElementById('diagram');
  try {
    if (
      typeof source !== 'string' ||
      new TextEncoder().encode(source).byteLength > 32768 ||
      source.split('\n').length > 300
    )
      throw new Error('Diagram exceeds preview limit');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      maxTextSize: 32768,
      maxEdges: 300,
      flowchart: { htmlLabels: false },
      theme: theme === 'dark' ? 'dark' : 'neutral',
      secure: [
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'secure',
        'theme',
        'themeVariables',
      ],
    });
    const result = await mermaid.render('cwdiagram', source);
    if (result.svg.length > 2 * 1024 * 1024)
      throw new Error('Diagram output exceeds limit');
    element.innerHTML = result.svg;
    parent.postMessage({ type: 'cw-diagram-result' }, '*');
    if (expanded()) fit();
    else measureDiagram();
  } catch {
    element.textContent = 'Unable to render diagram; view source.';
    parent.postMessage({ type: 'cw-diagram-result', error: true }, '*');
  }
});
