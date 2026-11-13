import type { PropValue, Property } from './types.ts';
export type FormulaNode =
  | { kind: 'literal'; value: PropValue }
  | { kind: 'call'; name: string; args: FormulaNode[] }
  | { kind: 'operator'; name: string; args: FormulaNode[] };
export type FormulaResult =
  | { ok: true; ast: FormulaNode; resultType: 'text' | 'number' | 'checkbox' | 'date' }
  | { ok: false; message: string; at: number };
export interface FormulaContext {
  getProperty(name: string): PropValue | undefined;
  now?: Date;
  today?: string;
}
const arity: Record<string, [number, number]> = {
  prop: [1, 1],
  if: [3, 3],
  empty: [1, 1],
  length: [1, 1],
  concat: [0, 200],
  lower: [1, 1],
  upper: [1, 1],
  contains: [2, 2],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  min: [1, 200],
  max: [1, 200],
  now: [0, 0],
  today: [0, 0],
  dateAdd: [3, 3],
  dateSubtract: [3, 3],
  dateBetween: [3, 3],
  formatDate: [1, 2],
  year: [1, 1],
  month: [1, 1],
  day: [1, 1],
  weekday: [1, 1],
  toNumber: [1, 1],
  format: [1, 1],
};
const functions = new Set(
  'prop if empty length concat lower upper contains round floor ceil abs min max now today dateAdd dateSubtract dateBetween formatDate year month day weekday toNumber format'.split(
    ' ',
  ),
);
export function inferFormulaType(
  ast: FormulaNode,
  schema: Property[] = [],
  seen: Set<string> = new Set(),
): 'text' | 'number' | 'checkbox' | 'date' {
  if (ast.kind === 'literal')
    return typeof ast.value === 'boolean' ? 'checkbox' : typeof ast.value === 'number' ? 'number' : 'text';
  const n = ast.name;
  if (ast.kind === 'operator')
    return ['==', '!=', '>', '<', '>=', '<=', 'and', 'or', 'not'].includes(n)
      ? 'checkbox'
      : n === '+' && ast.args.some((a) => inferFormulaType(a, schema, seen) === 'text')
        ? 'text'
        : 'number';
  if (n === 'prop') {
    const a = ast.args[0];
    const p = a?.kind === 'literal' ? schema.find((p) => p.name === a.value || p.id === a.value) : undefined;
    if (p?.type === 'formula' && p.formula && !seen.has(p.id)) {
      const parsed = parseFormula(p.formula.expression);
      if (parsed.ok) return inferFormulaType(parsed.ast, schema, new Set([...seen, p.id]));
    }
    if (p?.formula?.resultType) return p.formula.resultType;
    return p?.type === 'date' || (p?.type === 'rollup' && ['earliest', 'latest'].includes(p.rollup?.fn ?? ''))
      ? 'date'
      : p?.type === 'checkbox'
        ? 'checkbox'
        : p?.type === 'number' || (p?.type === 'rollup' && p.rollup?.fn !== 'show')
          ? 'number'
          : 'text';
  }
  if (n === 'if') return ast.args[1] ? inferFormulaType(ast.args[1], schema, seen) : 'text';
  return ['now', 'today', 'dateAdd', 'dateSubtract'].includes(n)
    ? 'date'
    : ['empty', 'contains'].includes(n)
      ? 'checkbox'
      : [
            'length',
            'round',
            'floor',
            'ceil',
            'abs',
            'min',
            'max',
            'dateBetween',
            'year',
            'month',
            'day',
            'weekday',
            'toNumber',
          ].includes(n)
        ? 'number'
        : 'text';
}
export function parseFormula(source: string, schema: Property[] = []): FormulaResult {
  let at = 0,
    count = 0;
  const fail = (message: string): never => {
    throw { message, at };
  };
  try {
    if (source.length > 2000) fail('Expression exceeds 2000 characters');
    const tokens: { v: string; at: number; value?: PropValue }[] = [];
    while (at < source.length) {
      if (/\s/.test(source[at])) {
        at++;
        continue;
      }
      const start = at,
        c = source[at];
      if (c === '"' || c === "'") {
        at++;
        let value = '';
        let closed = false;
        while (at < source.length) {
          const ch = source[at++];
          if (ch === c) {
            closed = true;
            break;
          }
          if (ch === '\\') {
            const next = source[at++];
            value += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[next] ?? next;
          } else value += ch;
        }
        if (!closed) fail('Unterminated string');
        tokens.push({ v: 'literal', value, at: start });
        continue;
      }
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
      if (m) {
        tokens.push({ v: 'literal', value: Number(m[0]), at });
        at += m[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(at));
      if (id) {
        tokens.push({ v: id[0], at });
        at += id[0].length;
        continue;
      }
      const op = /^(==|!=|>=|<=|[+*/%(),<>-])/.exec(source.slice(at));
      if (!op) fail('Unexpected character');
      tokens.push({ v: op![0], at });
      at += op![0].length;
    }
    tokens.push({ v: 'EOF', at });
    let i = 0;
    const node = (n: FormulaNode) => {
      if (++count > 200) fail('Expression exceeds 200 nodes');
      return n;
    };
    const precedence: Record<string, number> = {
      or: 1,
      and: 2,
      '==': 3,
      '!=': 3,
      '>': 4,
      '<': 4,
      '>=': 4,
      '<=': 4,
      '+': 5,
      '-': 5,
      '*': 6,
      '/': 6,
      '%': 6,
    };
    const expression = (min = 0, depth = 0): FormulaNode => {
      if (depth > 200) fail('Expression too deep');
      const t = tokens[i++];
      at = t.at;
      let left!: FormulaNode;
      if (t.v === 'literal') left = node({ kind: 'literal', value: t.value! });
      else if (t.v === 'true' || t.v === 'false') left = node({ kind: 'literal', value: t.v === 'true' });
      else if (t.v === '-' || t.v === 'not')
        left = node({
          kind: 'operator',
          name: t.v === '-' ? 'neg' : 'not',
          args: [expression(t.v === 'not' ? 3 : 7, depth + 1)],
        });
      else if (t.v === '(') {
        left = expression(0, depth + 1);
        if (tokens[i++].v !== ')') fail('Expected )');
      } else if (/^[A-Za-z_]/.test(t.v) && t.v !== 'EOF') {
        if (!functions.has(t.v)) fail('Unknown function ' + t.v);
        if (tokens[i++].v !== '(') fail('Expected (');
        const args: FormulaNode[] = [];
        if (tokens[i].v !== ')') {
          do {
            args.push(expression(0, depth + 1));
            if (tokens[i].v !== ',') break;
            i++;
          } while (true);
        }
        if (tokens[i++].v !== ')') fail('Expected )');
        left = node({ kind: 'call', name: t.v, args });
      } else fail('Expected expression');
      while ((precedence[tokens[i].v] ?? -1) >= min) {
        const op = tokens[i++].v;
        left = node({ kind: 'operator', name: op, args: [left, expression(precedence[op] + 1, depth + 1)] });
      }
      return left;
    };
    const ast = expression();
    if (tokens[i].v !== 'EOF') {
      at = tokens[i].at;
      fail('Unexpected token');
    }
    return { ok: true, ast, resultType: inferFormulaType(ast, schema) };
  } catch (e) {
    const error = e as { message?: string; at?: number };
    return { ok: false, message: error.message ?? 'Invalid expression', at: error.at ?? at };
  }
}
const number = (x: PropValue): number => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw Error();
  return x;
};
const text = (x: PropValue) => (x == null ? '' : Array.isArray(x) ? x.join(', ') : String(x));
const date = (x: PropValue) => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(x)) throw Error();
  const d = new Date(x);
  const [year, month, day] = x.slice(0, 10).split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isFinite(d.getTime()) || month < 1 || month > 12 || day < 1 || day > last) throw Error();
  return d;
};
const boolean = (x: PropValue) => {
  if (typeof x !== 'boolean') throw Error();
  return x;
};
const comparable = (x: PropValue) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(x) ? +date(x) : x);
export function evaluateFormula(formula: FormulaResult | FormulaNode, ctx: FormulaContext): PropValue {
  try {
    if ('ok' in formula && !formula.ok) return null;
    const ast = 'ok' in formula ? formula.ast : formula;
    const ev = (n: FormulaNode): PropValue => {
      if (n.kind === 'literal') return n.value;
      const [a, b, c] = n.args;
      if (n.kind === 'operator') {
        const x = ev(a);
        if (n.name === 'not') return !boolean(x);
        if (n.name === 'neg') return -number(x);
        if (n.name === 'and') return boolean(x) && boolean(ev(b));
        if (n.name === 'or') return boolean(x) || boolean(ev(b));
        const y = ev(b),
          compare = ['==', '!=', '>', '<', '>=', '<='].includes(n.name),
          cx = compare ? comparable(x) : x,
          cy = compare ? comparable(y) : y;
        switch (n.name) {
          case '+':
            return typeof x === 'string' || typeof y === 'string' ? text(x) + text(y) : number(x) + number(y);
          case '-':
            return number(x) - number(y);
          case '*':
            return number(x) * number(y);
          case '/':
          case '%':
            if (number(y) === 0) throw Error();
            return n.name === '/' ? number(x) / number(y) : number(x) % number(y);
          case '==':
            return cx === cy;
          case '!=':
            return cx !== cy;
          case '>':
          case '<':
          case '>=':
          case '<=':
            if (typeof x !== typeof y || x === null || y === null) throw Error();
            if (cx === null || cy === null) throw Error();
            return n.name === '>' ? cx > cy : n.name === '<' ? cx < cy : n.name === '>=' ? cx >= cy : cx <= cy;
        }
        throw Error();
      }
      if (n.kind === 'call') {
        const bounds = arity[n.name];
        if (!bounds || n.args.length < bounds[0] || n.args.length > bounds[1]) throw Error();
      }
      if (n.name === 'if') {
        if (n.args.length !== 3) throw Error();
        return boolean(ev(a)) ? ev(b) : ev(c);
      }
      if (n.name === 'prop') {
        const key = ev(a);
        if (typeof key !== 'string') throw Error();
        const value = ctx.getProperty(key);
        if (value === undefined) throw Error();
        return value;
      }
      const v = n.args.map(ev),
        x = v[0],
        y = v[1];
      switch (n.name) {
        case 'empty':
          return x == null || x === '' || (Array.isArray(x) && !x.length);
        case 'length':
          if (typeof x !== 'string' && !Array.isArray(x)) throw Error();
          return x.length;
        case 'concat':
          return v.map(text).join('');
        case 'lower':
        case 'upper':
          if (typeof x !== 'string') throw Error();
          return n.name === 'lower' ? x.toLowerCase() : x.toUpperCase();
        case 'contains':
          if (typeof x !== 'string' || typeof y !== 'string') throw Error();
          return x.includes(y);
        case 'round': {
          const p = 10 ** (y === undefined ? 0 : number(y));
          return Math.round(number(x) * p) / p;
        }
        case 'floor':
          return Math.floor(number(x));
        case 'ceil':
          return Math.ceil(number(x));
        case 'abs':
          return Math.abs(number(x));
        case 'min':
          return Math.min(...v.map(number));
        case 'max':
          return Math.max(...v.map(number));
        case 'now':
          return (ctx.now ?? new Date()).toISOString();
        case 'today':
          return ctx.today ?? (ctx.now ?? new Date()).toISOString().slice(0, 10);
        case 'toNumber': {
          if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') throw Error();
          const value = Number(x);
          if (!Number.isFinite(value)) throw Error();
          return value;
        }
        case 'format':
          return text(x);
        case 'year':
          return date(x).getUTCFullYear();
        case 'month':
          return date(x).getUTCMonth() + 1;
        case 'day':
          return date(x).getUTCDate();
        case 'weekday':
          return date(x).getUTCDay();
        case 'formatDate': {
          const d = date(x);
          if (y === 'iso') return d.toISOString().slice(0, 10);
          if (y !== undefined && y !== 'short') throw Error();
          return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
        }
        case 'dateAdd':
        case 'dateSubtract':
        case 'dateBetween': {
          const d = date(x),
            unit = v[2];
          if (typeof unit !== 'string' || !['days', 'weeks', 'months', 'years', 'hours', 'minutes'].includes(unit))
            throw Error();
          if (n.name === 'dateBetween') {
            const other = date(y);
            if (unit === 'months' || unit === 'years') {
              let months = (d.getUTCFullYear() - other.getUTCFullYear()) * 12 + d.getUTCMonth() - other.getUTCMonth();
              if (months > 0 && d.getUTCDate() < other.getUTCDate()) months--;
              if (months < 0 && d.getUTCDate() > other.getUTCDate()) months++;
              return unit === 'years' ? Math.trunc(months / 12) : months;
            }
            return Math.trunc(
              (+d - +other) / { days: 864e5, weeks: 6048e5, hours: 36e5, minutes: 6e4 }[unit as 'days'],
            );
          }
          const amount = number(y) * (n.name === 'dateSubtract' ? -1 : 1);
          if (unit === 'months' || unit === 'years') {
            const day = d.getUTCDate();
            d.setUTCDate(1);
            d.setUTCMonth(d.getUTCMonth() + amount * (unit === 'years' ? 12 : 1));
            const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
            d.setUTCDate(Math.min(day, last));
          } else d.setTime(+d + amount * { days: 864e5, weeks: 6048e5, hours: 36e5, minutes: 6e4 }[unit as 'days']);
          return typeof x === 'string' && x.length === 10 && unit !== 'hours' && unit !== 'minutes'
            ? d.toISOString().slice(0, 10)
            : d.toISOString();
        }
        default:
          throw Error();
      }
    };
    const result = ev(ast);
    return typeof result === 'number' && !Number.isFinite(result) ? null : result;
  } catch {
    return null;
  }
}
