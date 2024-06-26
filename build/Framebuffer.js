import { Mutex } from "async-mutex";
export default class Framebuffer {
    fb;
    writemutex;
    size;
    constructor() {
        this.fb = Buffer.alloc(1);
        this.size = { height: 0, width: 0 };
        this.writemutex = new Mutex();
    }
    setSize(w, h) {
        var size = h * w * 4;
        this.size.height = h;
        this.size.width = w;
        this.fb = Buffer.alloc(size);
    }
    loadDirtyRect(rect, x, y, width, height) {
        if (this.fb.length < rect.length)
            throw new Error("Dirty rect larger than framebuffer (did you forget to set the size?)");
        return this.writemutex.runExclusive(() => {
            return new Promise((res, rej) => {
                var byteswritten = 0;
                for (var i = 0; i < height; i++) {
                    byteswritten += rect.copy(this.fb, 4 * ((y + i) * this.size.width + x), byteswritten, byteswritten + (width * 4));
                }
                res();
            });
        });
    }
    getFb() {
        return new Promise(async (res, rej) => {
            var v = await this.writemutex.runExclusive(() => {
                return new Promise((reso, reje) => {
                    var buff = Buffer.alloc(this.fb.length);
                    this.fb.copy(buff);
                    reso(buff);
                });
            });
            res(v);
        });
    }
}
