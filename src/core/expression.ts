import { canonicalJson, isRecord } from "./json.js";
import { SkillGraphError } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";

type Token = { kind: "value" | "identifier" | "operator" | "paren"; value: string };
type Context = { result: JsonObject; loop?: JsonObject };

function tokenize(source: string): Token[] {
  if (source.length > 2048) throw new SkillGraphError("invalid_route", "Route expression is too long");
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "(" || char === ")") { tokens.push({ kind: "paren", value: char }); index++; continue; }
    if (char === "\"" || char === "'") {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end++) {
        const current = source[end];
        if (!escaped && current === quote) break;
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
      }
      if (end >= source.length) throw new SkillGraphError("invalid_route", "Unterminated string in route expression");
      const raw = source.slice(index + 1, end);
      tokens.push({ kind: "value", value: quote === '"' ? JSON.parse(`"${raw}"`) : raw.replace(/\\'/g, "'").replace(/\\\\/g, "\\") });
      index = end + 1;
      continue;
    }
    const operator = source.slice(index).match(/^(===|!==|==|!=|>=|<=|&&|\|\||>|<|!)/)?.[1];
    if (operator) { tokens.push({ kind: "operator", value: operator }); index += operator.length; continue; }
    const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/)?.[0];
    if (identifier) { tokens.push({ kind: "identifier", value: identifier }); index += identifier.length; continue; }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?/ )?.[0];
    if (number) { tokens.push({ kind: "value", value: number }); index += number.length; continue; }
    throw new SkillGraphError("invalid_route", `Unsupported token near ${source.slice(index, index + 16)}`);
  }
  if (tokens.length > 100) throw new SkillGraphError("invalid_route", "Route expression has too many tokens");
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[], private readonly context: Context) {}

  parse(): boolean {
    const value = this.parseOr();
    if (this.index !== this.tokens.length) throw new SkillGraphError("invalid_route", "Unexpected token in route expression");
    return Boolean(value);
  }

  private parseOr(): JsonValue {
    let value = this.parseAnd();
    while (this.take("||")) value = Boolean(value) || Boolean(this.parseAnd());
    return value;
  }

  private parseAnd(): JsonValue {
    let value = this.parseComparison();
    while (this.take("&&")) value = Boolean(value) && Boolean(this.parseComparison());
    return value;
  }

  private parseComparison(): JsonValue {
    const left = this.parseUnary();
    const operator = this.peek("==") || this.peek("===") || this.peek("!=") || this.peek("!==") || this.peek(">=") || this.peek("<=") || this.peek(">") || this.peek("<");
    if (!operator) return left;
    this.index++;
    const right = this.parseUnary();
    switch (operator) {
      case "==": case "===": return canonicalJson(left) === canonicalJson(right);
      case "!=": case "!==": return canonicalJson(left) !== canonicalJson(right);
      case ">": return typeof left === "number" && typeof right === "number" && left > right;
      case ">=": return typeof left === "number" && typeof right === "number" && left >= right;
      case "<": return typeof left === "number" && typeof right === "number" && left < right;
      case "<=": return typeof left === "number" && typeof right === "number" && left <= right;
      default: return false;
    }
  }

  private parseUnary(): JsonValue {
    if (this.take("!")) return !Boolean(this.parseUnary());
    if (this.take("(")) {
      const value = this.parseOr();
      if (!this.take(")")) throw new SkillGraphError("invalid_route", "Missing closing parenthesis");
      return value;
    }
    const token = this.tokens[this.index++];
    if (!token) throw new SkillGraphError("invalid_route", "Missing expression value");
    if (token.kind === "value") {
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(token.value)) return Number(token.value);
      return token.value;
    }
    if (token.kind !== "identifier") throw new SkillGraphError("invalid_route", "Expected a value");
    return this.resolve(token.value);
  }

  private resolve(path: string): JsonValue {
    if (!/^(?:result|loop)(?:\.[A-Za-z_][A-Za-z0-9_]*|\.length)*$/.test(path)) throw new SkillGraphError("invalid_route", `Reference ${path} is not allowed`);
    const parts = path.split(".");
    let current: unknown = parts[0] === "result" ? this.context.result : this.context.loop;
    for (const part of parts.slice(1)) {
      if (part === "length" && Array.isArray(current)) current = current.length;
      else if (isRecord(current)) current = current[part];
      else current = undefined;
    }
    return current === undefined ? null : (current as JsonValue);
  }

  private peek(value: string): string | undefined {
    return this.tokens[this.index]?.value === value ? value : undefined;
  }

  private take(value: string): boolean {
    if (this.peek(value)) { this.index++; return true; }
    return false;
  }
}

export function evaluateExpression(source: string | undefined, context: Context): boolean {
  if (!source || !source.trim()) return true;
  return new Parser(tokenize(source), context).parse();
}
