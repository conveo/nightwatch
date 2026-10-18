type Child = Node | string | null | false

type Props = {
  className?: string
  attrs?: Record<string, string>
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null,
  children: Child[],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (props?.className != null) {
    element.className = props.className
  }
  for (const [name, value] of Object.entries(props?.attrs ?? {})) {
    element.setAttribute(name, value)
  }
  for (const [name, listener] of Object.entries(props?.on ?? {})) {
    if (listener != null) {
      element.addEventListener(name, listener)
    }
  }
  for (const child of children) {
    if (child == null || child === false) {
      continue
    }
    element.append(typeof child === "string" ? document.createTextNode(child) : child)
  }
  return element
}

export const SVG_NS = "http://www.w3.org/2000/svg"

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value)
  }
  return element
}
