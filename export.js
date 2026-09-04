export function setupPngExport({ modeler, getCurrentDiagram, setStatus }) {
  const exportPngButton = document.getElementById('export-png');
  const copyPngButton = document.getElementById('copy-png');

  function safeFilename(value) {
    return (value || 'diagram').trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'diagram';
  }

  function prepareSvg(svgText) {
    const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg.nodeName.toLowerCase() === 'parsererror') throw new Error('не удалось разобрать SVG');
    const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    let width = Number.parseFloat(svg.getAttribute('width'));
    let height = Number.parseFloat(svg.getAttribute('height'));
    if ((!Number.isFinite(width) || width <= 0) && viewBox.length === 4) width = viewBox[2];
    if ((!Number.isFinite(height) || height <= 0) && viewBox.length === 4) height = viewBox[3];
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('не удалось определить размер диаграммы');
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    return { svg: new XMLSerializer().serializeToString(svg), width, height };
  }

  function loadImage(svg) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      image.onload = () => resolve({ image, objectUrl });
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('браузер не смог отрисовать SVG'));
      };
      image.src = objectUrl;
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('не удалось сформировать PNG')), 'image/png'));
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setBusy(busy, activeButton) {
    const enabled = Boolean(getCurrentDiagram()) && !busy;
    exportPngButton.disabled = !enabled;
    copyPngButton.disabled = !enabled;
    exportPngButton.textContent = busy && activeButton === exportPngButton ? 'PNG…' : 'PNG';
    copyPngButton.textContent = busy && activeButton === copyPngButton ? 'Копирование…' : 'Копировать PNG';
  }

  async function renderPng() {
    const { svg } = await modeler.saveSVG();
    const prepared = prepareSvg(svg);
    const scale = Math.min(2, 8192 / prepared.width, 8192 / prepared.height);
    const width = Math.max(1, Math.round(prepared.width * scale));
    const height = Math.max(1, Math.round(prepared.height * scale));
    const loaded = await loadImage(prepared.svg);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D недоступен');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(loaded.image, 0, 0, width, height);
      return { blob: await canvasBlob(canvas), width, height };
    } finally {
      URL.revokeObjectURL(loaded.objectUrl);
    }
  }

  async function exportPng() {
    const diagram = getCurrentDiagram();
    if (!diagram) return;
    setBusy(true, exportPngButton);
    setStatus(`Экспорт «${diagram.name}»…`);
    try {
      const rendered = await renderPng();
      download(rendered.blob, `${safeFilename(diagram.id)}.png`);
      setStatus(`PNG экспортирован · ${rendered.width}×${rendered.height}`);
    } catch (error) {
      setStatus(`Не удалось экспортировать PNG: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyPng() {
    const diagram = getCurrentDiagram();
    if (!diagram) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      setStatus('Этот браузер не поддерживает копирование PNG в буфер обмена.');
      return;
    }
    setBusy(true, copyPngButton);
    setStatus(`Подготовка PNG «${diagram.name}» для буфера обмена…`);
    try {
      const renderedPromise = renderPng();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': renderedPromise.then(rendered => rendered.blob) })
      ]);
      const rendered = await renderedPromise;
      setStatus(`PNG скопирован в буфер · ${rendered.width}×${rendered.height}`);
    } catch (error) {
      setStatus(`Не удалось скопировать PNG: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  exportPngButton.addEventListener('click', () => void exportPng());
  copyPngButton.addEventListener('click', () => void copyPng());
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      void exportPng();
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copyPng();
    }
  });
}
