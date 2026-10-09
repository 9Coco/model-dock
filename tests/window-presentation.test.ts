import { describe, expect, it, vi } from 'vitest';
import { WindowPresentation } from '../src/main/window-presentation';

describe('首次窗口显示', () => {
  it.each(['renderer-first', 'paint-first'])('两种就绪顺序均等待首帧与页面，再显示一次：%s', order => {
    const show = vi.fn();
    const presentation = new WindowPresentation(true, show);
    if (order === 'renderer-first') presentation.rendererDidPrepare();
    else presentation.windowDidPaint();
    expect(show).not.toHaveBeenCalled();
    presentation.rendererDidPrepare(); presentation.windowDidPaint();
    expect(show.mock.calls).toEqual([[false]]);
    presentation.rendererDidPrepare(); presentation.windowDidPaint();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('隐藏启动完成绘制也不弹出，托盘打开才显示', () => {
    const show = vi.fn();
    const presentation = new WindowPresentation(false, show);
    presentation.rendererDidPrepare(); presentation.windowDidPaint();
    expect(show).not.toHaveBeenCalled();
    presentation.requestOpen();
    expect(show.mock.calls).toEqual([[true]]);
  });

  it('加载期间的打开请求不会提前显示，且第二次打开仍可恢复窗口', () => {
    const show = vi.fn();
    const presentation = new WindowPresentation(false, show);
    presentation.requestOpen(); presentation.rendererDidPrepare();
    expect(show).not.toHaveBeenCalled();
    presentation.windowDidPaint();
    expect(show.mock.calls).toEqual([[true]]);
    presentation.requestOpen();
    expect(show.mock.calls).toEqual([[true], [true]]);
  });

  it('显式激活新窗口保留聚焦意图', () => {
    const show = vi.fn();
    const presentation = new WindowPresentation(true, show, true);
    presentation.windowDidPaint(); presentation.rendererDidPrepare();
    expect(show.mock.calls).toEqual([[true]]);
  });
});
