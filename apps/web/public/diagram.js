/* global window, parent, document, mermaid, TextEncoder */
// Opaque sandbox: no application DOM, cookies, storage, or network access.
let initialized = false;
window.addEventListener('message', async (event) => {
  if (
    event.source !== parent ||
    initialized ||
    event.data?.type !== 'cw-diagram'
  )
    return;
  initialized = true;
  const source = event.data.source;
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
      theme: 'neutral',
      secure: [
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'secure',
      ],
    });
    const result = await mermaid.render('cwdiagram', source);
    if (result.svg.length > 2 * 1024 * 1024)
      throw new Error('Diagram output exceeds limit');
    element.innerHTML = result.svg;
    parent.postMessage({ type: 'cw-diagram-result' }, '*');
  } catch {
    element.textContent = 'Unable to render diagram; view source.';
    parent.postMessage({ type: 'cw-diagram-result', error: true }, '*');
  }
});
