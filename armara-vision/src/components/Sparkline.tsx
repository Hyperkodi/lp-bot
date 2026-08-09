// Dependency-free inline-SVG sparkline (server-renderable).
export default function Sparkline({
  values,
  width = 120,
  height = 28,
  stroke = "#e8a33d",
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return <span className="text-[10px] text-terminal-muted">building…</span>;
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const pts = clean
    .map((v, i) => {
      const x = (i / (clean.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.2" />
    </svg>
  );
}
