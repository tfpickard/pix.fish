'use client';

import * as d3 from 'd3';
import { useEffect, useRef, useState } from 'react';

export type LineageNode = { id: number; slug: string; blobUrl: string };
export type LineageEdge = {
  childImageId: number;
  parentImageId: number;
  promptUsed: string | null;
  dialectUsed: string | null;
};

interface SimNode extends d3.SimulationNodeDatum, LineageNode {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  edge: LineageEdge;
}

const HEIGHT = 600;
const RADIUS = 18;

// Force-directed parent -> child lineage graph. Click a node to open the
// image; click an edge to inspect the prompt/dialect that produced the child.
// Pure d3 over an SVG (the repo already hand-rolls its viz; d3 is added only
// here for the force layout, which is fiddly to do by hand).
export function LineageGraph({ nodes, edges }: { nodes: LineageNode[]; edges: LineageEdge[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<LineageEdge | null>(null);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || nodes.length === 0) return;
    const width = svgEl.clientWidth || 800;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', 'lineage-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', RADIUS + 8)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#6b7280');

    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }));
    const idSet = new Set(simNodes.map((n) => n.id));
    const simLinks: SimLink[] = edges
      .filter((e) => idSet.has(e.parentImageId) && idSet.has(e.childImageId))
      .map((e) => ({ source: e.parentImageId, target: e.childImageId, edge: e }));

    // Per-node circular clip so the thumbnail reads as a disc.
    for (const n of simNodes) {
      defs.append('clipPath').attr('id', `lineage-clip-${n.id}`).append('circle').attr('r', RADIUS);
    }

    const root = svg.append('g');
    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 4])
        .on('zoom', (event) => root.attr('transform', event.transform.toString()))
    );

    const link = root
      .append('g')
      .selectAll('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', '#4b5563')
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#lineage-arrow)')
      .style('cursor', 'pointer')
      .on('click', (_event, d) => setSelected(d.edge));

    const node = root
      .append('g')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes)
      .join('g')
      .style('cursor', 'pointer')
      .on('click', (_event, d) => {
        window.location.href = `/${d.slug}`;
      });

    node
      .append('image')
      .attr('href', (d) => d.blobUrl)
      .attr('x', -RADIUS)
      .attr('y', -RADIUS)
      .attr('width', RADIUS * 2)
      .attr('height', RADIUS * 2)
      .attr('preserveAspectRatio', 'xMidYMid slice')
      .attr('clip-path', (d) => `url(#lineage-clip-${d.id})`);

    node
      .append('circle')
      .attr('r', RADIUS)
      .attr('fill', 'none')
      .attr('stroke', '#9ca3af')
      .attr('stroke-width', 1.5);

    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    node.call(drag);

    const sim = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        d3.forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(90)
      )
      .force('charge', d3.forceManyBody().strength(-220))
      .force('center', d3.forceCenter(width / 2, HEIGHT / 2))
      .force('collide', d3.forceCollide(RADIUS + 8))
      .on('tick', () => {
        link
          .attr('x1', (d) => (d.source as SimNode).x ?? 0)
          .attr('y1', (d) => (d.source as SimNode).y ?? 0)
          .attr('x2', (d) => (d.target as SimNode).x ?? 0)
          .attr('y2', (d) => (d.target as SimNode).y ?? 0);
        node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

    return () => {
      sim.stop();
    };
  }, [nodes, edges]);

  if (nodes.length === 0) {
    return (
      <p className="font-mono text-xs text-ink-500">
        no lineage yet. upload an image with parents selected to start the graph.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <svg
        ref={svgRef}
        width="100%"
        height={HEIGHT}
        className="rounded-lg border border-ink-800 bg-ink-950/40"
      />
      {selected ? (
        <div className="space-y-1 rounded border border-ink-800 bg-ink-900/40 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase text-ink-500">edge</span>
            <button
              onClick={() => setSelected(null)}
              className="font-mono text-[10px] text-ink-500 hover:text-ink-200"
            >
              close
            </button>
          </div>
          {selected.dialectUsed ? (
            <p className="font-mono text-[11px] text-ink-400">dialect: {selected.dialectUsed}</p>
          ) : null}
          <p className="font-mono text-xs text-ink-200">
            {selected.promptUsed || '(no prompt recorded for this edge)'}
          </p>
        </div>
      ) : (
        <p className="font-mono text-[11px] text-ink-600">
          drag to rearrange. click a node to open the image; click an edge to see its prompt.
        </p>
      )}
    </div>
  );
}
