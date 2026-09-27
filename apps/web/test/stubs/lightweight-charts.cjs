/**
 * Inert CommonJS stand-in for `lightweight-charts`, used by the server-render
 * tests (see `bootstrap.cjs`).
 */
const ColorType = { Solid: 'solid', VerticalGradient: 'gradient' };
const CrosshairMode = { Normal: 0, Magnet: 1 };
const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 };
const CandlestickSeries = 'Candlestick';
const HistogramSeries = 'Histogram';
const LineSeries = 'Line';
const AreaSeries = 'Area';
const BarSeries = 'Bar';
const BaselineSeries = 'Baseline';

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

function createChart() {
  return {
    addSeries: () => inertSeries(),
    addPane: () => inertPane(),
    panes: () => [inertPane()],
    priceScale: () => ({ applyOptions: () => undefined }),
    timeScale: () => ({
      fitContent: () => undefined,
      applyOptions: () => undefined,
      scrollToPosition: () => undefined,
      getVisibleRange: () => undefined,
    }),
    resize: () => undefined,
    applyOptions: () => undefined,
    remove: () => undefined,
    subscribeCrosshairMove: () => undefined,
    unsubscribeCrosshairMove: () => undefined,
  };
}

function createSeriesMarkers() {
  return { setMarkers: () => undefined, applyOptions: () => undefined, detach: () => undefined };
}

module.exports = {
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  BarSeries,
  BaselineSeries,
  createChart,
  createSeriesMarkers,
  default: { createChart, createSeriesMarkers, ColorType, CrosshairMode, LineStyle, CandlestickSeries, HistogramSeries },
};
