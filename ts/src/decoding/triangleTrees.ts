/**
 * Triangle trees (`docs/specification/v2.md#triangle-trees`): a tessellation stored as two-bit
 * symbols, one per triangle in preorder, and the outline cycle of each tree.
 *
 * Bit 0 of a symbol says a child lies across the triangle's `to -> apex` edge, bit 1 across
 * `apex -> from`. A tree of `n` triangles has `n + 2` cycle entries: the root's `from` and `to`,
 * then the apex of each triangle in in-order. The reference is `codecs/tri.rs` in mlt-core.
 */

/** Rebuilds three vertex indices per symbol: `(from, to, apex)` in symbol order. */
export function decodeTriangleTrees(symbols: Uint32Array, cycles: Uint32Array): Uint32Array {
    for (let i = 0; i < symbols.length; i++) {
        if (symbols[i] > 3) {
            throw new Error(`Triangle tree symbol ${symbols[i]} at ${i} is above 3`);
        }
    }
    const sizes = subtreeSizes(symbols);
    const out = new Uint32Array(symbols.length * 3);
    let root = 0;
    let at = 0;
    while (root < symbols.length) {
        const size = sizes[root];
        if (at + 2 + size > cycles.length) {
            throw new Error("Triangle tree cycles end inside a tree");
        }
        unfold(symbols, sizes, root, cycles[at], cycles[at + 1], cycles, at + 2, out);
        root += size;
        at += 2 + size;
    }
    if (at !== cycles.length) {
        throw new Error("Triangle tree cycles hold more entries than the trees take");
    }
    return out;
}

/** The triangle count of each node's subtree, and a zero past the last node. */
function subtreeSizes(symbols: Uint32Array): Uint32Array {
    const end = symbols.length;
    const sizes = new Uint32Array(end + 1);
    let unfinished = false;
    for (let node = end - 1; node >= 0; node--) {
        const symbol = symbols[node];
        const hasLeft = symbol & 1;
        const hasRight = symbol >> 1;
        const leftSize = hasLeft ? sizes[node + 1] : 0;
        const rightRoot = node + 1 + leftSize;
        const rightSize = hasRight ? sizes[rightRoot] : 0;
        if ((hasLeft && node + 1 === end) || (hasRight && rightRoot === end)) {
            unfinished = true;
        }
        sizes[node] = 1 + leftSize + rightSize;
    }
    if (unfinished) {
        throw new Error("Triangle tree symbols end inside a tree");
    }
    return sizes;
}

/**
 * Appends the tree at `root`, entered across `from -> to`, taking each apex by its left subtree's
 * size. Frames pop in preorder, so the node a frame enters is always the next one.
 */
function unfold(
    symbols: Uint32Array,
    sizes: Uint32Array,
    root: number,
    from: number,
    to: number,
    cycles: Uint32Array,
    apexStart: number,
    out: Uint32Array,
): void {
    const size = sizes[root];
    // Three slots per frame: from, to, first apex. A tree is at most `size` deep.
    const frames = new Uint32Array((size + 1) * 3);
    frames[0] = from;
    frames[1] = to;
    frames[2] = 0;
    let pending = 1;
    for (let node = root; node < root + size; node++) {
        pending--;
        const entryFrom = frames[pending * 3];
        const entryTo = frames[pending * 3 + 1];
        const firstApex = frames[pending * 3 + 2];
        const symbol = symbols[node];
        const hasLeft = symbol & 1;
        const hasRight = symbol >> 1;
        const leftSize = hasLeft ? sizes[node + 1] : 0;
        const apex = cycles[apexStart + firstApex + leftSize];
        out[node * 3] = entryFrom;
        out[node * 3 + 1] = entryTo;
        out[node * 3 + 2] = apex;
        // The right child goes under the left one, so the left one pops first.
        frames[pending * 3] = entryFrom;
        frames[pending * 3 + 1] = apex;
        frames[pending * 3 + 2] = firstApex + leftSize + 1;
        pending += hasRight;
        frames[pending * 3] = apex;
        frames[pending * 3 + 1] = entryTo;
        frames[pending * 3 + 2] = firstApex;
        pending += hasLeft;
    }
}
