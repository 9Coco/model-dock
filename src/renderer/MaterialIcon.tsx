import { forwardRef, type CSSProperties, type SVGProps } from 'react';
import { materialIconNames, materialSymbolPaths } from './assets/material-symbols/paths';

export type MaterialSymbolName = keyof typeof materialSymbolPaths;
export interface MaterialIconProps extends SVGProps<SVGSVGElement> {
  size?: string | number;
  /** Nine primary navigation symbols include Google's genuine fill 1 paths. */
  filled?: boolean;
  /** Accepted for the migrated icon call sites; source weight remains 400. */
  absoluteStrokeWidth?: boolean;
}
type SymbolPaths = { viewBox: string; outline: readonly string[]; filled?: readonly string[] };
type IconStyle = CSSProperties & { '--material-fill'?: 0 | 1 };

/** Local official SVG geometry. Decorative by default; all ordinary SVG/ARIA
 * props and refs remain available without font ligatures or injected markup.
 */
export const MaterialIcon = forwardRef<SVGSVGElement, MaterialIconProps & { symbol: MaterialSymbolName }>(function MaterialIcon({ symbol, size = 24, filled, className = '', style, absoluteStrokeWidth: _absolute, strokeWidth: _stroke, children, ...props }, ref) {
  const source: SymbolPaths = materialSymbolPaths[symbol];
  const iconStyle: IconStyle = { display: 'inline-block', verticalAlign: 'middle', flex: '0 0 auto', width: size, height: size, ...style,
    ...(filled === undefined ? {} : { '--material-fill': filled ? 1 : 0 }) };
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox={source.viewBox} width={size} height={size} fill="currentColor" focusable="false" aria-hidden="true"
    {...props} ref={ref} className={`material-icon ${className}`.trim()} style={iconStyle} data-material-symbol={symbol} data-icon-family="material-symbols-rounded">
    {source.filled ? <>
      <g className="material-icon-outline" style={{ opacity: 'calc(1 - var(--material-fill, 0))' }}>{source.outline.map((d, index) => <path key={index} d={d} />)}</g>
      <g className="material-icon-filled" style={{ opacity: 'var(--material-fill, 0)' }}>{source.filled.map((d, index) => <path key={index} d={d} />)}</g>
    </> : source.outline.map((d, index) => <path key={index} d={d} />)}
    {children}
  </svg>;
});

function icon(name: keyof typeof materialIconNames) {
  const Component = forwardRef<SVGSVGElement, MaterialIconProps>((props, ref) => <MaterialIcon {...props} symbol={materialIconNames[name]} ref={ref} />);
  Component.displayName = name;
  return Component;
}
export const Activity = icon('Activity');
export const ArrowDownToLine = icon('ArrowDownToLine');
export const ArrowLeft = icon('ArrowLeft');
export const ArrowRight = icon('ArrowRight');
export const ArrowUpRight = icon('ArrowUpRight');
export const BarChart3 = icon('BarChart3');
export const BookOpen = icon('BookOpen');
export const Box = icon('Box');
export const Check = icon('Check');
export const CheckCheck = icon('CheckCheck');
export const ChevronDown = icon('ChevronDown');
export const CircleHelp = icon('CircleHelp');
export const Clock3 = icon('Clock3');
export const Copy = icon('Copy');
export const Database = icon('Database');
export const DollarSign = icon('DollarSign');
export const Download = icon('Download');
export const Ellipsis = icon('Ellipsis');
export const Eye = icon('Eye');
export const FileCode2 = icon('FileCode2');
export const FileText = icon('FileText');
export const FolderOpen = icon('FolderOpen');
export const Globe2 = icon('Globe2');
export const Info = icon('Info');
export const KeyRound = icon('KeyRound');
export const Layers3 = icon('Layers3');
export const LoaderCircle = icon('LoaderCircle');
export const LogOut = icon('LogOut');
export const Monitor = icon('Monitor');
export const Moon = icon('Moon');
export const Pencil = icon('Pencil');
export const Plug2 = icon('Plug2');
export const Plus = icon('Plus');
export const Power = icon('Power');
export const Radio = icon('Radio');
export const RefreshCw = icon('RefreshCw');
export const Repository = icon('Repository');
export const RotateCcw = icon('RotateCcw');
export const ScrollText = icon('ScrollText');
export const Search = icon('Search');
export const Server = icon('Server');
export const Settings2 = icon('Settings2');
export const ShieldCheck = icon('ShieldCheck');
export const Sparkles = icon('Sparkles');
export const Sun = icon('Sun');
export const Terminal = icon('Terminal');
export const Trash2 = icon('Trash2');
export const Unplug = icon('Unplug');
export const Upload = icon('Upload');
export const UserRound = icon('UserRound');
export const Waypoints = icon('Waypoints');
export const X = icon('X');
export const Zap = icon('Zap');
