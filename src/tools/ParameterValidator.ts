import { BaseTool, type ToolArgs, type ToolDefinition, type ToolParameter } from './BaseTool';

export type CommandArgumentValue = string | number | boolean;
export type ParsedCommandArgs = ToolArgs & Record<string, CommandArgumentValue>;

export interface ValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  value: T;
  errors: string[];
  issues: ValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function schemaTypes(schema: ToolParameter): string[] {
  const values = Array.isArray(schema.type) ? schema.type : [schema.type];
  return values.filter((value): value is string => typeof value === 'string');
}

function issue(path: string, message: string, keyword: string): ValidationIssue {
  return { path: path || '$', message, keyword };
}

function validateValue(value: unknown, schema: ToolParameter, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (schema.const !== undefined && value !== schema.const) issues.push(issue(path, 'Value does not match the required constant', 'const'));
  if (schema.oneOf) {
    const matches = schema.oneOf.some((candidate) => { const candidateIssues: ValidationIssue[] = []; validateValue(value, candidate, path, candidateIssues); return candidateIssues.length === 0; });
    if (!matches) issues.push(issue(path, 'Value does not match any allowed schema', 'oneOf'));
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some((candidate) => { const candidateIssues: ValidationIssue[] = []; validateValue(value, candidate, path, candidateIssues); return candidateIssues.length === 0; });
    if (!matches) issues.push(issue(path, 'Value does not match any allowed schema', 'anyOf'));
  }
  if (value === null && (schema.nullable === true || schemaTypes(schema).includes('null'))) return;

  const types = schemaTypes(schema);
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    issues.push(issue(path, `Expected ${types.join(' or ')}`, 'type'));
    return;
  }

  if (schema.enum && !schema.enum.some((entry) => entry === value)) {
    issues.push(issue(path, `Value must be one of: ${schema.enum.map(String).join(', ')}`, 'enum'));
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(issue(path, `Must contain at least ${schema.minLength} characters`, 'minLength'));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(issue(path, `Must contain at most ${schema.maxLength} characters`, 'maxLength'));
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) issues.push(issue(path, 'Does not match the required pattern', 'pattern'));
      } catch {
        issues.push(issue(path, 'Schema pattern is invalid', 'pattern'));
      }
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(issue(path, `Must be >= ${schema.minimum}`, 'minimum'));
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(issue(path, `Must be <= ${schema.maximum}`, 'maximum'));
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push(issue(path, `Must be > ${schema.exclusiveMinimum}`, 'exclusiveMinimum'));
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) issues.push(issue(path, `Must be < ${schema.exclusiveMaximum}`, 'exclusiveMaximum'));
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(issue(path, `Must contain at least ${schema.minItems} items`, 'minItems'));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(issue(path, `Must contain at most ${schema.maxItems} items`, 'maxItems'));
    if (schema.uniqueItems === true) {
      const encoded = value.map((entry) => JSON.stringify(entry));
      if (new Set(encoded).size !== encoded.length) issues.push(issue(path, 'Items must be unique', 'uniqueItems'));
    }
    if (schema.items) value.forEach((entry, index) => validateValue(entry, schema.items as ToolParameter, `${path}[${index}]`, issues));
  }

  if (isRecord(value) && (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || schema.properties)) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        issues.push(issue(`${path}.${key}`, 'Required property is missing', 'required'));
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      const child = properties[key];
      if (child) validateValue(entry, child, `${path}.${key}`, issues);
      else if (schema.additionalProperties === false) issues.push(issue(`${path}.${key}`, 'Additional properties are not allowed', 'additionalProperties'));
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateValue(entry, schema.additionalProperties, `${path}.${key}`, issues);
    }
  }
}

export function validateJsonSchema<T = unknown>(schema: ToolParameter | ToolDefinition['function']['parameters'], value: unknown): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  validateValue(value, schema as ToolParameter, '$', issues);
  return {
    valid: issues.length === 0,
    value: value as T,
    errors: issues.map((entry) => `${entry.path}: ${entry.message}`),
    issues,
  };
}

const ACTION_REQUIREMENTS: Record<string, Record<string, readonly string[]>> = {
  media_library: { search: ['query'], link: ['item_id'], info: ['item_id'] },
  media_request: { request: ['media_type', 'media_id'], status: ['request_id'] },
  memory: { store: ['content'], forget: ['id'] },
  pdf_tool: { split: ['start_page', 'end_page'], remove_pages: ['pages'], rotate: ['degrees'] },
  menfess: {},
  groupadmin: { add: ['user'], remove: ['user'], kick: ['user'], mute: ['user'], unmute: ['user'], promote: ['user'], demote: ['user'] },
};

function validateActionRequirements(tool: BaseTool, args: Record<string, unknown>, result: ValidationResult): void {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const required = action ? ACTION_REQUIREMENTS[tool.name]?.[action] : undefined;
  if (!required) return;
  for (const key of required) {
    if (args[key] === undefined) {
      result.valid = false;
      result.errors.push(`$.${key}: required for action ${action}`);
      result.issues.push(issue(`$.${key}`, 'Required for this action', 'required'));
    }
  }
}

const ACTION_ARGUMENTS: Record<string, Record<string, readonly string[]>> = {
  media_request: {
    request: ['media_type', 'media_id', 'seasons'],
    status: ['request_id'],
  },
  media_library: { search: ['query'], link: ['item_id'], info: ['item_id'] },
  memory: { consent: ['scope'], revoke: [], store: ['content', 'scope', 'consent'], retrieve: ['scope'], forget: ['id'] },
  groupadmin: { add: ['user'], remove: ['user'], kick: ['user'], mute: ['user'], unmute: ['user'], promote: ['user'], demote: ['user'] },
  owner_admin: { broadcast: ['message'], leave: [], system_info: [] },
  reminder: { list: [], cancel: ['number'] },
  role: {
    check: ['user'],
    list: ['scope'],
    grant: ['user', 'role', 'scope'],
    revoke: ['user', 'role', 'scope'],
    privs: ['role'],
    setpriv: ['role', 'field', 'value'],
    resetpriv: ['role'],
  },
  pdf_tool: {
    split: ['start_page', 'end_page'],
    remove_pages: ['pages'],
    rotate: ['degrees'],
    add_watermark: ['watermark_text'],
    edit_metadata: ['author', 'title', 'subject'],
  },
};

function parseActionSpecific(
  tool: BaseTool,
  tokens: string[],
  action: string,
  properties: Record<string, ToolParameter>,
  normalizedCommand: string,
): ParsedCommandArgs | null {
  const fields = ACTION_ARGUMENTS[tool.name]?.[action];
  if (!fields) return null;
  const values = [...tokens];
  if (values[0]?.toLowerCase() === action.toLowerCase()) values.shift();
  const overrides: Record<string, string> = {};
  const positional = values.filter((token) => {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && fields.includes(match[1])) {
      overrides[match[1]] = match[2];
      return false;
    }
    return true;
  });
  const result: ParsedCommandArgs = { action };
  let index = 0;
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
    const field = fields[fieldIndex] as string;
    if (overrides[field] !== undefined) {
      result[field] = parseScalar(overrides[field], properties[field], field);
      continue;
    }
    if (index >= positional.length) break;
    const remaining = fields.slice(fieldIndex + 1).length;
    const parameter = properties[field];
    const trailingField = ['query', 'message', 'content', 'watermark_text'].includes(field);
    if (parameter?.type === 'string' && (fieldIndex === fields.length - 1 || remaining === 0 || trailingField)) {
      result[field] = positional.slice(index).join(' ');
      index = values.length;
    } else {
      result[field] = parseScalar(values[index] as string, parameter, field);
      index += 1;
    }
  }
  if (index < positional.length) throw new Error(`Unexpected argument: ${positional.slice(index).join(' ')}`);
  if (normalizedCommand) result.__command = normalizedCommand;
  assertParsedEnums(result, properties);
  assertParsedActionRequirements(tool, result);
  return result;
}

function assertParsedActionRequirements(tool: BaseTool, args: ParsedCommandArgs): void {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const required = action ? ACTION_REQUIREMENTS[tool.name]?.[action] : undefined;
  if (!required) return;
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length > 0) throw new Error(`Missing argument(s) for ${action}: ${missing.join(', ')}`);
}

export function validateToolArguments<T = unknown>(toolOrDefinition: BaseTool | ToolDefinition, value: unknown): ValidationResult<T> {
  const definition = toolOrDefinition instanceof BaseTool ? toolOrDefinition.definition : toolOrDefinition;
  const rawParameters = definition.function.parameters;
  const parameters = { ...rawParameters, additionalProperties: rawParameters.additionalProperties ?? false } as ToolParameter;
  const sanitized = isRecord(value) && Object.prototype.hasOwnProperty.call(value, '__command')
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__command'))
    : value;
  const result = validateJsonSchema<T>(parameters, sanitized);
  result.value = sanitized as T;
  if (result.valid && toolOrDefinition instanceof BaseTool && isRecord(sanitized) && typeof sanitized.action === 'string' && toolOrDefinition.commandGrammar) {
    const variant = toolOrDefinition.commandGrammar.variants.find((entry) => entry.value === sanitized.action);
    if (!variant) {
      result.valid = false;
      result.errors.push(`$.action: unsupported action ${sanitized.action}`);
      result.issues.push(issue('$.action', `Unsupported action ${sanitized.action}`, 'action'));
    } else {
      const allowed = new Set(variant.arguments.map((argument) => argument.name));
      for (const argument of variant.arguments) {
        if (argument.required && sanitized[argument.name] === undefined) {
          result.valid = false;
          result.errors.push(`$.${argument.name}: required for action ${sanitized.action}`);
          result.issues.push(issue(`$.${argument.name}`, 'Required for this action', 'required'));
        }
      }
      for (const key of Object.keys(sanitized)) {
        if (key === 'action' || key === '__command' || allowed.has(key)) continue;
        result.valid = false;
        result.errors.push(`$.${key}: unexpected for action ${sanitized.action}`);
        result.issues.push(issue(`$.${key}`, 'Unexpected for this action', 'additionalProperties'));
      }
    }
  }
  if (result.valid && toolOrDefinition instanceof BaseTool && isRecord(sanitized)) validateActionRequirements(toolOrDefinition, sanitized, result);
  return result;
}

export function assertValidToolArguments(toolOrDefinition: BaseTool | ToolDefinition, value: unknown): void {
  const result = validateToolArguments(toolOrDefinition, value);
  if (!result.valid) throw new Error(`Invalid tool arguments: ${result.errors.join('; ')}`);
}

function getNoArgAliases(tool: BaseTool): Set<string> {
  return new Set([...tool.noArgAliases, ...defaultNoArgAliases(tool.name)]);
}

function defaultNoArgAliases(toolName: string): string[] {
  const values: Record<string, string[]> = {
    groupadmin: ['mute', 'unmute', 'grouplink', 'kick', 'add', 'remove', 'promote', 'demote'],
    owner_admin: ['leave', 'botleave'],
    media_account: ['connect', 'disconnect', 'notify'],
    media_library: ['library', 'watching'],
    media_search: ['find'],
    role: [],
  };
  return values[toolName] ?? [];
}

function commandAction(toolName: string, command: string): string | undefined {
  const actions: Record<string, Record<string, string>> = {
    media_search: { find: 'trending', 'search-media': 'search' },
    media_library: { library: 'latest', watching: 'latest' },
    media_account: { connect: 'connect', disconnect: 'disconnect', notify: 'notify' },
    media_request: { status: 'status', 'my-requests': 'my-requests' },
    reminder: { remind: 'set', reminder: 'set' },
    memory: { remember: 'store', forget: 'forget', recall: 'retrieve' },
    role: { role: 'check', roles: 'check', permission: 'check', perm: 'check' },
    groupadmin: { mute: 'mute', unmute: 'unmute', grouplink: 'link', kick: 'remove', add: 'add', remove: 'remove', promote: 'promote', demote: 'demote' },
    owner_admin: { leave: 'leave', botleave: 'leave' },
  };
  return actions[toolName]?.[command];
}

function defaultInferredAction(toolName: string, command: string | undefined): string | undefined {
  if (!command) return undefined;
  const key = command.toLowerCase();
  const values: Record<string, Record<string, string>> = {
    groupadmin: { mute: 'mute', unmute: 'unmute', grouplink: 'link', add: 'add', kick: 'remove', remove: 'remove', promote: 'promote', demote: 'demote' },
    owner_admin: { leave: 'leave', botleave: 'leave' },
    media_account: { connect: 'connect', disconnect: 'disconnect', notify: 'notify' },
    media_library: { library: 'latest', watching: 'latest' },
    media_search: { find: 'trending' },
  };
  return values[toolName]?.[key];
}

export function parseCommandString(commandString: string): string[] {
  if (!commandString) return [];
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let tokenStarted = false;
  for (const char of commandString.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        result.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (escaped) current += '\\';
  if (tokenStarted || current.length > 0) result.push(current);
  return result;
}

function assertGrammar(tool: BaseTool, result: ParsedCommandArgs): void {
  const grammar = tool.commandGrammar;
  if (!grammar || typeof result.action !== 'string') return;
  const variant = grammar.variants.find((entry) => entry.value === result.action);
  if (!variant) throw new Error(`Unsupported action: ${result.action}`);
  const allowed = new Set(variant.arguments.map((argument) => argument.name));
  for (const key of Object.keys(result)) {
    if (key === 'action' || key === '__command') continue;
    if (!allowed.has(key)) throw new Error(`Unexpected argument: ${key}`);
  }
  for (const argument of variant.arguments) {
    if (argument.required && result[argument.name] === undefined) throw new Error(`Missing argument: ${argument.name}`);
  }
}

function assertParsedEnums(result: ParsedCommandArgs, properties: Record<string, ToolParameter>): void {
  for (const [key, value] of Object.entries(result)) {
    if (key === '__command') continue;
    const parameter = properties[key];
    if (parameter?.enum) {
      const exact = parameter.enum.some((entry) => entry === value);
      if (!exact) {
        const canonical = parameter.enum.find((entry) => String(entry).toLowerCase() === String(value).toLowerCase());
        if (canonical === undefined) throw new Error(`Parameter <${key}> must be one of: ${parameter.enum.map(String).join(', ')}`);
        result[key] = canonical as CommandArgumentValue;
      }
    }
  }
}

function parseScalar(value: string, parameter: ToolParameter | undefined, key: string): CommandArgumentValue {
  const kind = Array.isArray(parameter?.type) ? parameter?.type[0] : parameter?.type;
  if (kind === 'number' || kind === 'integer') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (kind === 'integer' && !Number.isInteger(parsed))) throw new Error(`Parameter <${key}> must be a valid number.`);
    return parsed;
  }
  if (kind === 'boolean') {
    const normalized = value.toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    throw new Error(`Parameter <${key}> must be true or false.`);
  }
  return value;
}

export const parseExplicitCommand = (tool: BaseTool, args: string, command?: string): ParsedCommandArgs => ParameterValidator.parseArgs(tool, args, command);
export const parseCommand = parseExplicitCommand;
export const validateArguments = validateToolArguments;
export const validateJsonSchemaArguments = validateJsonSchema;

export class ParameterValidator {
  static parseArgs(tool: BaseTool, argsStr: string, command?: string): ParsedCommandArgs {
    const def = tool.definition.function.parameters;
    const properties = def.properties || {};
    const keys = Object.keys(properties);
    const normalizedCommand = (command ?? '').trim().replace(/^\/+/, '').toLowerCase();
    const noArg = normalizedCommand && getNoArgAliases(tool).has(normalizedCommand);

    if (keys.length === 0) return normalizedCommand ? { __command: normalizedCommand } : {};

    if (!argsStr.trim() && !normalizedCommand && keys[0] === 'action' && def.required?.includes('action') && getNoArgAliases(tool).size > 0) return {};

    const tokens = parseCommandString(argsStr);
    const inferred = commandAction(tool.name, normalizedCommand) ?? defaultInferredAction(tool.name, normalizedCommand);
    const actionProperty = keys.length > 0 ? properties[keys[0]] : undefined;
    const actionValues = actionProperty?.enum?.map((value) => String(value).toLowerCase()) ?? [];
    let effectiveInferred = inferred;
    // When the typed command is itself a valid action value (`/broadcast`,
    // `/leave`), the command name *is* the action. Requiring `noArg` here meant
    // that `/broadcast <text>` had no inferred action at all, so the first
    // positional token was assigned to `action` and then rejected by the enum.
    if (normalizedCommand && actionValues.includes(normalizedCommand)) effectiveInferred = normalizedCommand;
    if (!normalizedCommand && tool.name === 'media_search' && tokens.length > 0 && !actionValues.includes(tokens[0].toLowerCase())) effectiveInferred = 'search';
    if (!normalizedCommand && tool.name === 'role' && tokens.length > 0 && !actionValues.includes(tokens[0].toLowerCase())) effectiveInferred = 'check';
    if (tool.name === 'media_search' && normalizedCommand === 'find' && tokens.length > 0) effectiveInferred = 'search';
    if (noArg && !argsStr.trim()) {
      return effectiveInferred ? { action: effectiveInferred, __command: normalizedCommand } : normalizedCommand ? { __command: normalizedCommand } : {};
    }

    const tokenAction = actionValues.includes(tokens[0]?.toLowerCase() ?? '') ? tokens[0] : undefined;
    const explicitAction = tokenAction ?? effectiveInferred;
    if (explicitAction) {
      const actionSpecific = parseActionSpecific(tool, tokens, explicitAction, properties, normalizedCommand);
      if (actionSpecific) return actionSpecific;
    }

    if (keys.length === 1 && properties[keys[0]]?.type === 'string') {
      const key = keys[0];
      if (!argsStr && def.required?.includes(key) && !noArg) throw new Error(this.getUsageHelp(tool));
      const result: ParsedCommandArgs = {};
      if (argsStr || !noArg) result[key] = argsStr;
      if (normalizedCommand) result.__command = normalizedCommand;
      assertParsedEnums(result, properties);
      assertGrammar(tool, result);
      assertParsedActionRequirements(tool, result);
      return result;
    }

    const result: ParsedCommandArgs = {};
    let index = 0;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = keys[keyIndex];
      const property = properties[key];
      if (keyIndex === 0 && explicitAction && actionValues.length > 0 && tokens.length > 0 && !actionValues.includes(tokens[0].toLowerCase())) {
        // Use the action that was actually resolved (token-detected first, then
        // inferred). Reading `effectiveInferred` here discarded the token and
        // re-derived the action, so a tool whose first positional token *was* a
        // valid action fell back to the wrong default variant.
        result.action = explicitAction;
        continue;
      }
      if (index >= tokens.length) break;
      const remainingRequired = keys.slice(keyIndex + 1).filter((next) => def.required?.includes(next)).length;
      const isFinal = keyIndex === keys.length - 1;
      const laterKeys = keys.slice(keyIndex + 1);
      const trailingString = ['query', 'message', 'content', 'watermark_text'].includes(key) && !laterKeys.some((next) => def.required?.includes(next));
      const isLastString = (property?.type === 'string' && !laterKeys.some((next) => properties[next]?.type === 'string') && (isFinal || !laterKeys.some((next) => def.required?.includes(next)))) || trailingString;
      if (isLastString && tokens.length - index > remainingRequired) {
        result[key] = tokens.slice(index).join(' ');
        index = tokens.length;
      } else {
        result[key] = parseScalar(tokens[index] as string, property, key);
        index += 1;
      }
    }

    if (index < tokens.length) throw new Error(`Unexpected argument: ${tokens.slice(index).join(' ')}`);
    const missing = def.required?.filter((key) => result[key] === undefined) ?? [];
    if (missing.length > 0 && !noArg) throw new Error(this.getUsageHelp(tool));
    if (effectiveInferred && result.action === undefined) result.action = effectiveInferred;
    if (normalizedCommand) result.__command = normalizedCommand;
    assertParsedEnums(result, properties);
    assertGrammar(tool, result);
    assertParsedActionRequirements(tool, result);
    return result;
  }

  static parseCommandString(commandString: string): string[] {
    return parseCommandString(commandString);
  }

  static validate<T = unknown>(tool: BaseTool, args: unknown): ValidationResult<T> {
    return validateToolArguments<T>(tool, args);
  }

  static validateArgs<T = unknown>(tool: BaseTool, args: unknown): ValidationResult<T> {
    return validateToolArguments<T>(tool, args);
  }

  static assertValid(tool: BaseTool, args: unknown): void {
    assertValidToolArguments(tool, args);
  }

  static getUsageHelp(tool: BaseTool): string {
    const name = tool.aliases.length > 0 ? tool.aliases[0] : tool.name;
    const props = tool.definition.function.parameters?.properties || {};
    let help = `Invalid usage.\n\n*Usage:* /${name}`;
    for (const key of Object.keys(props)) help += tool.definition.function.parameters.required?.includes(key) ? ` <${key}>` : ` [${key}]`;
    help += `\n\n*Description:*\n${tool.description}`;
    const enumEntries = Object.entries(props).filter(([, prop]) => prop.enum && prop.enum.length > 0);
    if (enumEntries.length > 0) {
      help += `\n\n*Available Options:*`;
      for (const [key, prop] of enumEntries) help += `\n  *${key}:* ${prop.enum!.map(String).join(' | ')}`;
    }
    return help;
  }
}

export default ParameterValidator;
