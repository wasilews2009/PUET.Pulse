import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Renders TeX into `el` as DOM nodes (KaTeX builds elements, no innerHTML).
 * trust: false keeps \href, \url, \htmlClass and friends disabled; limits stop
 * expansion bombs. Errors render as the source text in the error colour.
 */
export function renderMath(el: HTMLElement, tex: string, display: boolean) {
  katex.render(tex, el, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    maxSize: 20,
    maxExpand: 200,
    output: 'htmlAndMathml',
    errorColor: '#DF4827',
  });
}
