/**
 * Test-only stub for `lightweight-charts`.
 *
 * The real package ships ES modules only, so a CommonJS server-render test
 * cannot require it. The chart is a canvas component with no server-rendered
 * output at all: `createChart` is only ever called from an effect, which
 * `renderToString` does not run. This stub therefore returns inert objects and
 * exists purely so the module graph resolves.
 */

export const ColorType = { Solid: 'solid', VerticalGradient: 'gradient' } as const;
export const CrosshairMode = { Normal: 0, Magnet: 1 } as const;
export const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 } as const;
export const CandlestickSeries = 'Candlestick';
export const HistogramSeries = 'Histogram';
export const LineSeries = 'Line';
export const AreaSeries = 'Area';
export const BarSeries = 'Bar';
export const BaselineSeries = 'Baseline';

const inertSeries = () => ({
  setData: () => undefined,
  update: () => undefined,
  applyOptions: () => undefined,
  createPriceLine: () => ({ applyOptions: () => undefined, remove: () => undefined }),
  remove: () => undefined,
  dataByIndex: () => undefined,
});

const inertPane = () => ({
  addSeries: () => inertSeries(),
  paneIndex: () => 0,
  moveTo: () => undefined,
  getHeight: () => 0,
  setHeight: () => undefined,
});

export function createChart(): Record<string, unknown> {
  return {
    addSeries: () => inertSeries(),
    addPane: () => inertPane(),
    panes: () => [inertPane()],
    priceScale: () => ({ applyOptions: () => undefined }),
    timeScale: () => ({ fitContent: () => undefined, applyOptions: () => undefined, scrollToPosition: () => undefined, getVisibleRange: () => undefined }),
    resize: () => undefined,
    applyOptions: () => undefined,
    remove: () => undefined,
    subscribeCrosshairMove: () => undefined,
    unsubscribeCrosshairMove: () => undefined,
  };
}

export function createSeriesMarkers() {
  return { setMarkers: () => undefined, applyOptions: () => undefined, detach: () => undefined };
}

export default { createChart, createSeriesMarkers, ColorType, CrosshairMode, LineStyle, CandlestickSeries, HistogramSeries };
