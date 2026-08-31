export function setupPngExport({ modeler, getCurrentDiagram, setStatus }) {
  const exportPngButton = document.getElementById('export-png');

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

  async function exportPng() {
    const diagram = getCurrentDiagram();
    if (!diagram) return;
    exportPngButton.disabled = true;
    exportPngButton.textContent = 'PNG…';
    setStatus(`Экспорт «${diagram.name}»…`);
    try {
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
        download(await canvasBlob(canvas), `${safeFilename(diagram.id)}.png`);
        setStatus(`PNG экспортирован · ${width}×${height}`);
      } finally {
        URL.revokeObjectURL(loaded.objectUrl);
      }
    } catch (error) {
      setStatus(`Не удалось экспортировать PNG: ${error.message}`);
    } finally {
      exportPngButton.disabled = !getCurrentDiagram();
      exportPngButton.textContent = 'PNG';
    }
  }

  exportPngButton.addEventListener('click', exportPng);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      void exportPng();
    }
  });
}
