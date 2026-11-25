/**
 * WebGL2 基础封装：程序、纹理、帧缓冲、异步回读。
 * 全部逐像素运算都在 GPU 完成，CPU 只负责调度与指标统计。
 */

export interface TypedArrayCtor<T extends TypedArray = TypedArray> {
  new (n: number): T;
}

type TypedArray = Float32Array | Uint8Array | Int32Array | Uint32Array;

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  private quadVAO: WebGLVertexArrayObject;
  readonly supportFloat: boolean;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2，请使用最新版 Chrome/Edge。');
    this.gl = gl;
    const ext = gl.getExtension('EXT_color_buffer_float');
    this.supportFloat = !!ext;
    gl.getExtension('OES_texture_float_linear');

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('无法创建 VAO');
    this.quadVAO = vao;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  fullscreen(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  createProgram(fragSrc: string, macros?: Record<string, string>): Program {
    return createProgram(this.gl, fragSrc, macros);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '未知编译错误';
    gl.deleteShader(shader);
    throw new Error(`Shader 编译失败:\n${log}\n--- 源码 ---\n${src}`);
  }
  return shader;
}

export class Program {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {
    this.program = program;
    this.gl = gl;
  }

  private gl: WebGL2RenderingContext;

  use(): void {
    this.gl.useProgram(this.program);
  }

  loc(name: string): WebGLUniformLocation | null {
    let u = this.uniforms.get(name);
    if (u === undefined) {
      u = this.gl.getUniformLocation(this.program, name);
      this.uniforms.set(name, u);
    }
    return u;
  }

  tex(name: string, unit: number, tex: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const l = this.loc(name);
    if (l) gl.uniform1i(l, unit);
  }

  f1(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  f2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }
  f4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
  }
  i1(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  iv1(name: string, data: Int32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1iv(l, data);
  }
}

export function createProgram(
  gl: WebGL2RenderingContext,
  fragSrc: string,
  macros?: Record<string, string>,
): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  let header = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  if (macros) {
    for (const [k, v] of Object.entries(macros)) header += `#define ${k} ${v}\n`;
  }
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, header + fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '未知链接错误';
    gl.deleteProgram(program);
    throw new Error(`Program 链接失败: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return new Program(gl, program);
}

export interface TextureOptions {
  internalFormat?: number;
  format?: number;
  type?: number;
  filter?: number;
  wrap?: number;
  mipmaps?: boolean;
}

export class Texture2D {
  readonly tex: WebGLTexture;
  width = 0;
  height = 0;
  readonly internalFormat: number;
  readonly format: number;
  readonly type: number;
  readonly mipmaps: boolean;
  private gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, opts: TextureOptions = {}) {
    this.gl = gl;
    this.internalFormat = opts.internalFormat ?? gl.RGBA8;
    this.format = opts.format ?? gl.RGBA;
    this.type = opts.type ?? gl.UNSIGNED_BYTE;
    this.mipmaps = opts.mipmaps ?? false;
    const tex = gl.createTexture();
    if (!tex) throw new Error('无法创建纹理');
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = opts.filter ?? gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.mipmaps) {
      // 显式分配完整 mip 链，R32F 等浮点格式同样适用
      let cw = w;
      let ch = h;
      let level = 0;
      while (cw >= 1 && ch >= 1) {
        gl.texImage2D(gl.TEXTURE_2D, level, this.internalFormat, cw, ch, 0, this.format, this.type, null);
        cw = Math.max(1, cw >> 1);
        ch = Math.max(1, ch >> 1);
        level++;
      }
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, w, h, 0, this.format, this.type, null);
    }
  }

  upload(src: TexImageSource): void {
    const gl = this.gl;
    this.width = (src as HTMLVideoElement).videoWidth || (src as HTMLCanvasElement).width;
    this.height = (src as HTMLVideoElement).videoHeight || (src as HTMLCanvasElement).height;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, this.format, this.type, src);
  }

  bind(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
  }

  generateMipmap(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}

export class Framebuffer {
  readonly fbo: WebGLFramebuffer;
  private gl: WebGL2RenderingContext;
  private attached: Texture2D | null = null;

  constructor(gl: WebGL2RenderingContext) {
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('无法创建 FBO');
    this.fbo = fbo;
    this.gl = gl;
  }

  bind(w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
  }

  attachColor(tex: Texture2D, level = 0): void {
    const gl = this.gl;
    if (this.attached === tex) return;
    this.attached = tex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex.tex,
      level,
    );
  }

  check(): void {
    const gl = this.gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO 不完整: 0x${status.toString(16)}`);
  }
}

/**
 * PBO + fence 多槽异步回读：本帧发起读取，间隔若干帧后取回数据，
 * 避免 glReadPixels 强制 GPU/CPU 同步导致掉帧。槽位数决定取回延迟。
 */
interface ReadSlot {
  pbo: WebGLBuffer;
  sync: WebGLSync | null;
  size: number;
  ctor: TypedArrayCtor;
  width: number;
  height: number;
  requestId: number;
}

export class AsyncReadback {
  private gl: WebGL2RenderingContext;
  private slots: ReadSlot[] = [];
  private cursor = 0;
  private nextId = 1;

  constructor(gl: WebGL2RenderingContext, slotCount = 8) {
    this.gl = gl;
    for (let i = 0; i < slotCount; i++) {
      const pbo = gl.createBuffer();
      if (!pbo) throw new Error('无法创建 PBO');
      this.slots.push({ pbo, sync: null, size: 0, ctor: Uint8Array, width: 0, height: 0, requestId: 0 });
    }
  }

  private bytesPerPixel(): number {
    return 4; // 当前只用于 RGBA8 回读
  }

  /**
   * 发起一次异步读取并轮转槽位；返回该槽位上一次（若干帧前）已完成的数据。
   * 调用前需已绑定好目标 FBO。
   */
  read<T extends TypedArray>(
    x: number,
    y: number,
    w: number,
    h: number,
    format: number,
    type: number,
    ctor: TypedArrayCtor<T>,
  ): T | null {
    const gl = this.gl;
    void format;
    void type;
    const slot = this.slots[this.cursor];
    const bpp = this.bytesPerPixel();
    const size = w * h * bpp;

    let out: T | null = null;
    if (slot.sync) {
      const status = gl.clientWaitSync(slot.sync, gl.SYNC_FLUSH_COMMANDS_BIT, 200_000);
      if (status !== gl.WAIT_FAILED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        const buf = new slot.ctor(slot.size) as T;
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf as unknown as ArrayBufferView);
        out = buf;
      }
      gl.deleteSync(slot.sync);
      slot.sync = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    if (slot.size < size) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      slot.size = size;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (slot.sync) gl.flush();
    slot.ctor = ctor as TypedArrayCtor;
    slot.width = w;
    slot.height = h;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    this.cursor = (this.cursor + 1) % this.slots.length;
    return out;
  }

  /**
   * 带请求 ID 的回读：发起请求返回 id；若干帧后用同一 id 轮询，
   * 数据就绪才返回，避免槽位错位。
   */
  request(x: number, y: number, w: number, h: number): number {
    const gl = this.gl;
    const slot = this.slots[this.cursor];
    const size = w * h * this.bytesPerPixel();
    if (slot.sync) {
      gl.clientWaitSync(slot.sync, 0, 0);
      gl.deleteSync(slot.sync);
      slot.sync = null;
    }
    if (slot.size < size) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      slot.size = size;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (slot.sync) gl.flush();
    slot.ctor = Uint8Array;
    slot.width = w;
    slot.height = h;
    const id = this.nextId++;
    slot.requestId = id;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.cursor = (this.cursor + 1) % this.slots.length;
    return id;
  }

  /** 按请求 ID 取回数据；未就绪返回 null。 */
  collect(id: number): Uint8Array | null {
    const gl = this.gl;
    const slot = this.slots.find((s) => s.requestId === id);
    if (!slot || !slot.sync) return null;
    const status = gl.clientWaitSync(slot.sync, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    const out = new Uint8Array(slot.size);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(slot.sync);
    slot.sync = null;
    slot.requestId = 0;
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.sync) gl.deleteSync(s.sync);
      gl.deleteBuffer(s.pbo);
    }
  }
}

/** 时序历史环形缓冲（用于多帧中值与静止区域检测）。 */
export class RingBuffer<T> {
  private items: T[] = [];
  private head = 0;

  constructor(factory: () => T, private capacity: number) {
    for (let i = 0; i < capacity; i++) this.items.push(factory());
  }

  get length(): number {
    return this.capacity;
  }

  /** 最旧 -> 最新 */
  all(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.capacity; i++) out.push(this.items[(this.head + 1 + i) % this.capacity]);
    return out;
  }

  /** 当前写入槽（上一帧数据，写入前可作为最旧样本参考） */
  current(): T {
    return this.items[this.head];
  }

  advance(): T {
    this.head = (this.head + 1) % this.capacity;
    return this.items[this.head];
  }

  newest(): T {
    return this.items[this.head];
  }

  oldest(): T {
    return this.items[(this.head + 1) % this.capacity];
  }
}
