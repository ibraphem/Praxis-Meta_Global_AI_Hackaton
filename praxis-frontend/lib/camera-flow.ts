import type { CircuitSessionView } from "./circuit-session";
/** Suggestions are for a repair destination only, never observed wire insertions. */
export function destinationHoles(
  view: CircuitSessionView,
  holes: { value: string; label: string }[],
) {
  const { graph, input, profile } = view;
  if (!graph || !input || !profile) return [];
  const device = graph.devices.find((d) => d.id === profile.mapping.D2),
    port = device?.ports.find((p) => p.role === "anode"),
    net = graph.nodes.find((n) => n.id === port?.nodeId)?.netId;
  if (!net) return [];
  return holes.filter((h) => {
    const split = h.value.indexOf("/"),
      board = h.value.slice(0, split),
      hole = h.value.slice(split + 1);
    return (
      graph.nodes.some(
        (n) => n.netId === net && n.members.includes(`hole:${board}:${hole}`),
      ) &&
      !input.associations.some(
        (a) =>
          a.state !== "rejected" &&
          a.target?.kind === "hole" &&
          a.target.boardId === board &&
          a.target.holeId === hole,
      )
    );
  });
}
export function friendlyCameraError(message: string) {
  if (/NotAllowedError|permission denied|denied permission/i.test(message))
    return "Camera access is blocked. Allow camera access in your browser, then try again.";
  if (/NotFoundError|Requested device not found/i.test(message))
    return "No camera was found. Connect a camera and try again.";
  if (/NotReadableError|Could not start video/i.test(message))
    return "This camera is busy. Close other apps using it, then reconnect.";
  if (/No saved camera session/i.test(message))
    return "No saved inspection on this browser yet. Start your camera to begin.";
  return message;
}
