import type { ImageSize, Point } from "@/lib/breadboard/calibration";

/** Enlarges original local image pixels; no canvas readback, network call or model output. */
export function CalibrationLoupe({
  imageUrl,
  image,
  point,
  label,
}: {
  imageUrl: string;
  image: ImageSize;
  point: Point | null;
  label: string;
}) {
  const radius = 24;
  return (
    <div
      className="calibration-loupe"
      aria-label="Magnified reference placement"
    >
      <strong>{label}</strong>
      <svg
        width="132"
        height="132"
        viewBox={
          point
            ? `${point.x - radius} ${point.y - radius} ${radius * 2} ${radius * 2}`
            : "0 0 132 132"
        }
        role="img"
        aria-label={
          point
            ? `Original-image detail at x ${point.x.toFixed(1)}, y ${point.y.toFixed(1)}`
            : "Move over the photo to inspect a hole before clicking"
        }
      >
        {point ? (
          <>
            <image
              href={imageUrl}
              x="0"
              y="0"
              width={image.width}
              height={image.height}
            />
            <path
              d={`M${point.x - 8} ${point.y}h5m6 0h5M${point.x} ${point.y - 8}v5m0 6v5`}
              className="loupe-crosshair"
            />
            <circle cx={point.x} cy={point.y} r="1" className="loupe-center" />
          </>
        ) : (
          <text x="66" y="50" textAnchor="middle" fill="#53664a" fontSize="10">
            <tspan x="66">Move over the photo</tspan>
            <tspan x="66" dy="15">
              to inspect a hole
            </tspan>
            <tspan x="66" dy="15">
              before clicking.
            </tspan>
          </text>
        )}
      </svg>
      <span>
        {point
          ? `x ${point.x.toFixed(1)} · y ${point.y.toFixed(1)} px`
          : "Tap or use pixel entry on touch devices."}
      </span>
    </div>
  );
}
