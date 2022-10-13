/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/common-utils";
import { Value, Anchor, FieldKey, symbolIsFieldKey } from "../../tree";
import {
    IEditableForest,
    TreeNavigationResult,
    mapCursorField,
    ITreeSubscriptionCursor,
    ITreeSubscriptionCursorState,
} from "../../forest";
import { brand } from "../../util";
import {
    FieldSchema,
    LocalFieldKey,
    TreeSchemaIdentifier,
    NamedTreeSchema,
    ValueSchema,
    lookupTreeSchema,
} from "../../schema-stored";
import { FieldKind, Multiplicity } from "../modular-schema";
import {
    AdaptingProxyHandler,
    adaptWithProxy,
    getFieldKind,
    getFieldSchema,
    getPrimaryField,
    isPrimitive,
    isPrimitiveValue,
    PrimitiveValue,
} from "./utilities";
import { EditableTreeContext, ProxyContext } from "./editableTreeContext";

/**
 * A symbol for extracting target from editable-tree proxies.
 * Useful for debugging and testing, but not part of the public API.
 */
export const proxyTargetSymbol: unique symbol = Symbol("editable-tree:proxyTarget");

/**
 * A symbol to get a function, which returns the type of a node in contexts
 * where string keys are already in use for fields.
 */
export const getTypeSymbol: unique symbol = Symbol("editable-tree:getType()");

/**
 * A symbol to get the value of a node in contexts where string keys are already in use for fields.
 */
export const valueSymbol: unique symbol = Symbol("editable-tree:value");

/**
 * A symbol to get the anchor of a node in contexts where string keys are already in use for fields.
 */
export const anchorSymbol: unique symbol = Symbol("editable-tree:anchor");

/**
 * A tree which can be traversed and edited.
 *
 * When iterating, only visits non-empty fields.
 * To discover empty fields, inspect the schema using {@link getTypeSymbol}.
 *
 * TODO: support editing.
 * TODO: `extends Iterable<EditableField>`
 * TODO: use proxies for array fields not just raw arrays (will be needed for laziness and editing).
 * TODO: provide non-schema impacted APIs for getting fields and nodes without unwrapping
 * (useful for generic code, and when references to these actual fields and nodes are required,
 * for example creating anchors and editing).
 */
export interface EditableTree {
    /**
     * A function to get the type of a node.
     * If this node is well-formed, it must follow this schema.
     * @param key - if key is supplied, returns the type of a non-sequence child node (if exists)
     * @param nameOnly - if true, returns only the type identifier
     */
    readonly [getTypeSymbol]: (
        key?: FieldKey,
        nameOnly?: boolean,
    ) => NamedTreeSchema | TreeSchemaIdentifier | undefined;

    /**
     * Value stored on this node.
     */
    readonly [valueSymbol]: Value;

    /**
     * Stores the target for the proxy which implements reading and writing for this node.
     * The details of this object are implementation details,
     * but the presence of this symbol can be used to separate EditableTrees from other types.
     */
    readonly [proxyTargetSymbol]: object;

    /**
     * Anchor to this node.
     * Valid as long as this EditableTree's context is not freed.
     * Might not point to any node if this node is deleted from the document.
     *
     * TODO: When a proper editing API is exposed on EditableTree directly,
     * this should become an implementation detail and rbe removed from this API surface.
     */
    readonly [anchorSymbol]: Anchor;

    /**
     * Fields of this node, indexed by their field keys (as strings).
     *
     * This API exposes content in a way depending on the {@link Multiplicity} of the {@link FieldKind}.
     * Sequences (including empty ones) are always exposed as arrays,
     * and everything else is either a single EditableTree or undefined depending on if it's empty.
     *
     * TODO:
     * This approach to field lookup can result in collisions between global and local keys,
     * particularly with "extra" fields.
     * A mechanism for disambiguating this should be added,
     * likely involving an alternative mechanism for looking up global fields via symbols.
     */
    readonly [key: FieldKey]: UnwrappedEditableField;
}

/**
 * EditableTree,
 * but with any type that `isPrimitive` unwrapped into the value if that value is a {@link PrimitiveValue}.
 */
export type EditableTreeOrPrimitive = EditableTree | PrimitiveValue;

/**
 * EditableTree, but with these cases of unwrapping:
 * - primitives are unwrapped. See {@link EditableTreeOrPrimitive}.
 * - nodes with PrimaryField are unwrapped to just the primaryField. See `getPrimaryField`.
 * - fields are unwrapped based on their schema's multiplicity. See {@link UnwrappedEditableField}.
 *
 * TODO:
 * EditableTree should provide easy access to children in a way thats guaranteed
 * not to do this unwrapping for cases which need to refer to the actual nodes.
 * This may include cases like creating anchors and/or editing.
 */
export type UnwrappedEditableTree = EditableTreeOrPrimitive | readonly UnwrappedEditableTree[];

/**
 * A field of an {@link EditableTree}.
 */
export type EditableField = readonly [FieldSchema, readonly EditableTree[]];

/**
 * Unwrapped field.
 * Non-sequence multiplicities are unwrapped to the child tree or `undefined` if there is none.
 * Sequence multiplicities are handled with arrays.
 * See {@link UnwrappedEditableTree} for how the children themselves are unwrapped.
 */
export type UnwrappedEditableField =
    | UnwrappedEditableTree
    | undefined
    | readonly UnwrappedEditableTree[];

export class ProxyTarget {
    private readonly lazyCursor: ITreeSubscriptionCursor;
    private anchor?: Anchor;

    constructor(public readonly context: ProxyContext, cursor: ITreeSubscriptionCursor) {
        this.lazyCursor = cursor.fork();
        context.withCursors.add(this);
    }

    public free(): void {
        this.lazyCursor.free();
        this.context.withCursors.delete(this);
        if (this.anchor !== undefined) {
            this.context.forest.anchors.forget(this.anchor);
            this.context.withAnchors.delete(this);
            this.anchor = undefined;
        }
    }

    public getAnchor(): Anchor {
        if (this.anchor === undefined) {
            this.anchor = this.lazyCursor.buildAnchor();
            this.context.withAnchors.add(this);
        }
        return this.anchor;
    }

    public prepareForEdit(): void {
        this.getAnchor();
        this.lazyCursor.clear();
        this.context.withCursors.delete(this);
    }

    public get cursor(): ITreeSubscriptionCursor {
        if (this.lazyCursor.state === ITreeSubscriptionCursorState.Cleared) {
            assert(
                this.anchor !== undefined,
                0x3c3 /* EditableTree should have an anchor if it does not have a cursor */,
            );
            const result = this.context.forest.tryMoveCursorTo(this.anchor, this.lazyCursor);
            assert(
                result === TreeNavigationResult.Ok,
                0x3c4 /* It is invalid to access an EditableTree node which no longer exists */,
            );
            this.context.withCursors.add(this);
        }
        return this.lazyCursor;
    }

    public getType(
        key?: FieldKey,
        nameOnly = true,
    ): NamedTreeSchema | TreeSchemaIdentifier | undefined {
        let typeName = this.cursor.type;
        if (key !== undefined) {
            const fieldLength = this.cursor.childFieldLength(key);
            assert(fieldLength <= 1, 0x3c5 /* invalid non sequence */);
            typeName = mapCursorField(this.cursor, key, (c) => c.type)[0];
        }
        if (nameOnly) {
            return typeName;
        }
        if (typeName) {
            return {
                name: typeName,
                ...lookupTreeSchema(this.context.forest.schema, typeName),
            };
        }
        return undefined;
    }

    get value(): Value {
        return this.cursor.value;
    }

    public lookupFieldKind(field: FieldKey): FieldKind {
        return getFieldKind(
            getFieldSchema(
                field,
                this.context.forest.schema,
                this.getType(undefined, false) as NamedTreeSchema,
            ),
        );
    }

    public getFieldKeys(): FieldKey[] {
        // For now this is an approximation:
        const fieldKeys: FieldKey[] = [];
        for (const key of this.cursor.keys) {
            // TODO: with new cursor API, field iteration will skip empty fields and this check can be removed.
            if (this.has(key)) {
                fieldKeys.push(key);
            }
        }
        return fieldKeys;
    }

    public has(field: FieldKey): boolean {
        // Make fields present only if non-empty.
        return this.cursor.childFieldLength(field) !== 0;
    }

    /**
     * @returns the key, if any, of the primary array field.
     */
    public getPrimaryArrayKey(): LocalFieldKey | undefined {
        const nodeType = this.getType(undefined, false) as NamedTreeSchema;
        const primary = getPrimaryField(nodeType);
        if (primary === undefined) {
            return undefined;
        }
        const kind = getFieldKind(primary.schema);
        if (kind.multiplicity === Multiplicity.Sequence) {
            // TODO: this could have issues if there are non-primary keys
            // that can collide with the array APIs (length or integers).
            return primary.key;
        }
        return undefined;
    }

    public proxifyField(field: FieldKey): UnwrappedEditableField {
        // Lookup the schema:
        const fieldKind = this.lookupFieldKind(field);
        // Make the childTargets:
        const childTargets = mapCursorField(
            this.cursor,
            field,
            (c) => new ProxyTarget(this.context, c),
        );
        return proxifyField(fieldKind, childTargets);
    }
}

/**
 * A Proxy handler together with a {@link ProxyTarget} implements a basic read/write access to the Forest
 * by means of the cursors.
 */
const handler: AdaptingProxyHandler<ProxyTarget, EditableTree> = {
    get: (target: ProxyTarget, key: string | symbol): unknown => {
        if (typeof key === "string" || symbolIsFieldKey(key)) {
            // All string keys are fields
            return target.proxifyField(brand(key));
        }
        // utility symbols
        switch (key) {
            case getTypeSymbol: {
                return target.getType.bind(target);
            }
            case valueSymbol: {
                return target.value;
            }
            case proxyTargetSymbol: {
                return target;
            }
            case anchorSymbol: {
                return target.getAnchor();
            }
            default:
                return undefined;
        }
    },
    set: (
        target: ProxyTarget,
        key: string | symbol,
        setValue: unknown,
        receiver: ProxyTarget,
    ): boolean => {
        throw new Error("Not implemented.");
    },
    deleteProperty: (target: ProxyTarget, key: string | symbol): boolean => {
        throw new Error("Not implemented.");
    },
    // Include documented symbols (except value when value is undefined) and all non-empty fields.
    has: (target: ProxyTarget, key: string | symbol): boolean => {
        if (typeof key === "string" || symbolIsFieldKey(key)) {
            return target.has(brand(key));
        }
        // utility symbols
        switch (key) {
            case proxyTargetSymbol:
            case getTypeSymbol:
            case anchorSymbol:
                // Currently not supporting iteration over fields.
                // case Symbol.iterator:
                return true;
            case valueSymbol:
                // Could do `target.value !== ValueSchema.Nothing`
                // instead if values which could be modified should report as existing.
                return target.value !== undefined;
            default:
                return false;
        }

        // For now primary array fields are handled by just returning the array, so we don't need this:
        // const length = target.getPrimaryArrayLength();
        // if (length !== undefined) {
        //     // Act like an array.
        //     // This means that "0" can be present, but not "0.0", "0.1", "-0", " 0" etc.
        //     // Simplest way to check for this is to round trip:
        //     if (key in []) {
        //         return true;
        //     }
        //     const numeric = Number(key);
        //     if (String(Number(key)) === key && Number.isInteger(numeric) && numeric >= 0 && numeric < length) {
        //         return true;
        //     }
        // }
    },
    // Includes all non-empty fields, which are the enumerable fields.
    ownKeys: (target: ProxyTarget): FieldKey[] => {
        return target.getFieldKeys();
    },
    getOwnPropertyDescriptor: (
        target: ProxyTarget,
        key: string | symbol,
    ): PropertyDescriptor | undefined => {
        // We generally don't want to allow users of the proxy to reconfigure all the properties,
        // but it is an TypeError to return non-configurable for properties that do not exist on target,
        // so they must return true.

        if ((typeof key === "string" || symbolIsFieldKey(key)) && target.has(brand(key))) {
            return {
                configurable: true,
                enumerable: true,
                value: target.proxifyField(brand(key)),
                writable: false,
            };
        }
        // utility symbols
        switch (key) {
            case proxyTargetSymbol:
                return { configurable: true, enumerable: false, value: target, writable: false };
            case getTypeSymbol:
                return {
                    configurable: true,
                    enumerable: false,
                    value: target.getType.bind(target),
                    writable: false,
                };
            case valueSymbol:
                return {
                    configurable: true,
                    enumerable: false,
                    value: target.value,
                    writable: false,
                };
            case anchorSymbol:
                return {
                    configurable: true,
                    enumerable: false,
                    value: target.getAnchor(),
                    writable: false,
                };
            default:
                return undefined;
        }
    },
};

/**
 * See {@link UnwrappedEditableTree} for documentation on what unwrapping this perform.
 */
function inProxyOrUnwrap(target: ProxyTarget): UnwrappedEditableTree {
    const fieldSchema = target.getType(undefined, false) as NamedTreeSchema;
    if (isPrimitive(fieldSchema)) {
        const nodeValue = target.cursor.value;
        if (isPrimitiveValue(nodeValue)) {
            return nodeValue;
        }
        assert(
            fieldSchema.value === ValueSchema.Serializable,
            0x3c7 /* `undefined` values not allowed for primitive fields */,
        );
    }
    const primary = target.getPrimaryArrayKey();
    if (primary !== undefined) {
        const childTargets = mapCursorField(
            target.cursor,
            primary,
            (c) => new ProxyTarget(target.context, c),
        );
        return childTargets.map(inProxyOrUnwrap);
    }
    return adaptWithProxy(target, handler);
}

/**
 * @param fieldKind - determines how return value should be typed. See {@link UnwrappedEditableField}.
 * @param childTargets - targets for the children of the field.
 */
export function proxifyField(
    fieldKind: FieldKind,
    childTargets: ProxyTarget[],
): UnwrappedEditableField {
    if (fieldKind.multiplicity === Multiplicity.Sequence) {
        // Return array for sequence fields
        return childTargets.map(inProxyOrUnwrap);
    } else {
        // Avoid wrapping non-sequence fields in arrays
        assert(childTargets.length <= 1, 0x3c8 /* invalid non sequence */);
        return childTargets.length === 1 ? inProxyOrUnwrap(childTargets[0]) : undefined;
    }
}

/**
 * A simple API for a Forest to interact with the tree.
 *
 * @returns {@link EditableTreeContext} which is used manage the cursors and anchors within the EditableTrees:
 * This is necessary for supporting using this tree across edits to the forest, and not leaking memory.
 */
export function getEditableTreeContext(forest: IEditableForest): EditableTreeContext {
    return new ProxyContext(forest);
}

/**
 * Checks the type of an UnwrappedEditableField.
 */
export function isArrayField(field: UnwrappedEditableField): field is UnwrappedEditableTree[] {
    return Array.isArray(field);
}

/**
 * Checks the type of an UnwrappedEditableField.
 */
export function isUnwrappedNode(field: UnwrappedEditableField): field is EditableTree {
    return typeof field === "object" && !isArrayField(field);
}