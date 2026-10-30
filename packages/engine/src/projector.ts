import type { Box } from './content'
import type { Mat4 } from './math'

const VERTEX_SHADER = `#version 300 es
in vec2 aCorner;
uniform mat4 uMatrix;
uniform vec2 uSize;
out vec2 vUv;
void main() {
  vUv = aCorner + 0.5;
  gl_Position = uMatrix * vec4(aCorner * uSize, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
uniform float uOpacity;
out vec4 color;
void main() {
  color = texture(uImage, vUv) * uOpacity;
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Could not create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader) ?? 'unknown error'}`)
  }
  return shader
}

/**
 * Draws a layer's flat picture as a card in true perspective, for layers with
 * depth or tilt. Each call renders one card into `canvas` (cleared first); the
 * caller then draws that canvas onto the comp, so stacking order is kept.
 */
export class CardProjector {
  readonly canvas: OffscreenCanvas
  private readonly gl: WebGL2RenderingContext
  private readonly texture: WebGLTexture
  private readonly uniforms: {
    matrix: WebGLUniformLocation | null
    size: WebGLUniformLocation | null
    opacity: WebGLUniformLocation | null
  }

  constructor() {
    this.canvas = new OffscreenCanvas(1, 1)
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl

    const program = gl.createProgram()
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader program failed to link: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`)
    }
    gl.useProgram(program)

    // One unit quad, centred on the origin, drawn as a triangle strip.
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW)
    const corner = gl.getAttribLocation(program, 'aCorner')
    gl.enableVertexAttribArray(corner)
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)

    this.uniforms = {
      matrix: gl.getUniformLocation(program, 'uMatrix'),
      size: gl.getUniformLocation(program, 'uSize'),
      opacity: gl.getUniformLocation(program, 'uOpacity'),
    }

    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  /**
   * Renders `image` (the layer's picture, sized `box` in comp pixels) through
   * `matrix`, which maps layer-local points to clip space.
   */
  render(image: TexImageSource, matrix: Mat4, box: Box, opacity: number, outputWidth: number, outputHeight: number): void {
    const { gl } = this
    if (this.canvas.width !== outputWidth || this.canvas.height !== outputHeight) {
      this.canvas.width = outputWidth
      this.canvas.height = outputHeight
    }
    gl.viewport(0, 0, outputWidth, outputHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)

    gl.uniformMatrix4fv(this.uniforms.matrix, false, new Float32Array(matrix))
    gl.uniform2f(this.uniforms.size, box.width, box.height)
    gl.uniform1f(this.uniforms.opacity, opacity)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}
