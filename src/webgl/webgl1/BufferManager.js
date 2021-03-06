let BufferRegion = require('./BufferRegion');
let vertgen = require('../vertgen');

const VERTEX_SIZE_BYTES = 24;

class Buffer {
    constructor(gl) {
        this.vbo = null;
        this.ibo = null;
        this.region = null;
        this.vboData = null;
        this.iboData = null;
        this.numVerts = 0;
        this.numIndices = 0;
    }

    allocate(gl) {
        try {
            const vboDataSize = BufferManager.NUM_VERTS * VERTEX_SIZE_BYTES;
            const iboDataSize = BufferManager.NUM_INDICES * 2;

            this.vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            gl.bufferData(gl.ARRAY_BUFFER, vboDataSize, gl.DYNAMIC_DRAW);

            this.ibo = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, iboDataSize, gl.DYNAMIC_DRAW);

            this.vboData = new ArrayBuffer(vboDataSize);
            this.iboData = new ArrayBuffer(iboDataSize);
        } catch (ex) {
            console.log('Buffer.allocate caught ex', ex);

            if (this.vbo) {
                gl.deleteBuffer(this.vbo);
                this.vbo = null;
            }

            if (this.ibo) {
                gl.deleteBuffer(this.ibo);
                this.ibo = null;
            }

            return false;
        }

        return true;
    }
}

// manager has a LRU list of buffers
// it also has a list of free buffers


export default class BufferManager {
    constructor(gl) {
        this.gl = gl;
        this.buffers = []; // LRU cache, most recently used is at the end
    }

    getBufferForRegion(region, endIndex, entities) {
        var buffer = null;
        var extraRegions = null;
        var i;

        // hunt through the buffer list for one that corresponds to this region
        for (i = 0; i < this.buffers.length; ++i) {
            if (this.buffers[i].region == region) {
                buffer = this.buffers[i];
                this.buffers.splice(i, 1);
                this.buffers.push(buffer);
                break;
            }
        }

        if (!buffer) {
            // try hunting for a buffer that's got no region
            for (i = 0; i < this.buffers.length; ++i) {
                if (!this.buffers[i].region) {
                    buffer = this.buffers[i];
                    this.buffers.splice(i, 1);
                    this.buffers.push(buffer);
                    break;
                }
            }
        }

        // next try allocating one
        if (!buffer) {
            buffer = this._allocBuffer();

            if (buffer) {
                this.buffers.push(buffer);
            }
        }

        // failing that, pull the first one off the LRU
        if (!buffer) {
            if (this.buffers.length == 0) {
                throw new Error('no buffers available!');
            }

            buffer = this.buffers.shift();
            this.buffers.push(buffer);
        }

        if (region.isMarked() || !buffer.region) {
            buffer.region = region;
            extraRegions = this._vertGenBuffer(buffer, region, endIndex, entities);
        }

        return { buffer: buffer, extraRegions: extraRegions };
    }

    _allocBuffer() {
        let numAllocated = this.buffers.length;
        if (numAllocated >= BufferManager.MAX_BUFFERS) {
            return null;
        }

        let buffer = new Buffer();
        if (!buffer.allocate(this.gl)) {
            return null;
        }

        return buffer;
    }

    _vertGenBuffer(buffer, region, endIndex, entities) {
        const gl = this.gl;
        const vboFloatView = new Float32Array(buffer.vboData);
        const vboUint8View = new Uint8Array(buffer.vboData);
        const vboInt8View = new Int8Array(buffer.vboData);
        const vboUint16View = new Uint16Array(buffer.vboData);
        const vboInt16View = new Int16Array(buffer.vboData);
        const iboUint16View = new Uint16Array(buffer.iboData);

        buffer.numVerts = 0;
        buffer.numIndices = 0;

        if (VERTEX_SIZE_BYTES % 4 != 0) {
            throw new Error('vertex size must be a multiple of float size');
        }

        let pushVert = (x, y, rx, ry, r, nx, ny, baryIndex, baryUnitLength, color) => {
            const floatBase = (VERTEX_SIZE_BYTES / 4) * buffer.numVerts;
            const byteBase = VERTEX_SIZE_BYTES * buffer.numVerts;
            const shortBase = (VERTEX_SIZE_BYTES / 2) * buffer.numVerts;

            var drx = rx - x;
            var dry = ry - y;

            vboFloatView[floatBase] = x;
            vboFloatView[floatBase + 1] = y;
            vboInt16View[shortBase + 4] = Math.round((drx / 512) * 32767);
            vboInt16View[shortBase + 5] = Math.round((dry / 512) * 32767);
            vboUint16View[shortBase + 6] = Math.round((baryUnitLength / 1024) * 65535);
            vboUint8View[byteBase + 14] = baryIndex;
            vboUint8View[byteBase + 15] = 0;
            vboUint16View[shortBase + 8] = Math.round((r / 1024) * 65535);
            vboInt8View[byteBase + 18] = Math.round((nx / 2) * 127);
            vboInt8View[byteBase + 19] = Math.round((ny / 2) * 127);
            vboUint8View[byteBase + 20] = color.r;
            vboUint8View[byteBase + 21] = color.g;
            vboUint8View[byteBase + 22] = color.b;
            vboUint8View[byteBase + 23] = color.a;

            return buffer.numVerts++;
        };

        let pushIndex = (vert) => {
            iboUint16View[buffer.numIndices++] = vert;
        };

        let pushIndices = (...verts) => {
            for (let v of verts) {
                pushIndex(v);
            }
        }

        var i;
        if (region.minIndex == Number.MIN_VALUE) {
            // can't possibly be anything before this so it's always 0
            i = 0;
        } else {
            i = entities.findIndexWithBinarySearch(function (entity) {
                return entity.zIndex - region.minIndex;
            });
        }

        var extraRegions = null;
        for (; i < entities.size() && entities.get(i).zIndex < endIndex; ++i) {
            var costs = vertgen.costOf(entities.get(i));

            if (costs.verts + buffer.numVerts > BufferManager.NUM_VERTS
                || costs.indices + buffer.numIndices > BufferManager.NUM_INDICES)
            {
                extraRegions = [ new BufferRegion(entities.get(i).zIndex) ];
                extraRegions[0].mark();
                break;
            }

            vertgen.generate(entities.get(i), pushVert, pushIndices);
        }

        region.unmark();

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer.ibo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(buffer.vboData, 0, buffer.numVerts * VERTEX_SIZE_BYTES));
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, new Uint8Array(buffer.iboData, 0, buffer.numIndices * 2));

        return extraRegions;
    }
}

// num verts is set to 65536 because indices are only 16 bit, thus limiting any
// given index buffer from referencing more than 65536 individual verts. the
// index buffer size is set based on a wildly optimistic assumption that all
// triangles will be perfectly stripped.
//
// we might either lower this or make it dynamically adapt.
BufferManager.NUM_VERTS = 65536;
BufferManager.NUM_INDICES = BufferManager.NUM_VERTS * 3;
BufferManager.VERT_SIZE = VERTEX_SIZE_BYTES;

BufferManager.MAX_BUFFERS = 256;
