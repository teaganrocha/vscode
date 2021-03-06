/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./goToDeclaration';
import * as nls from 'vs/nls';
import {Throttler} from 'vs/base/common/async';
import {onUnexpectedError} from 'vs/base/common/errors';
import {MarkedString, textToMarkedString} from 'vs/base/common/htmlContent';
import {KeyCode, KeyMod} from 'vs/base/common/keyCodes';
import * as platform from 'vs/base/common/platform';
import Severity from 'vs/base/common/severity';
import * as strings from 'vs/base/common/strings';
import {TPromise} from 'vs/base/common/winjs.base';
import * as browser from 'vs/base/browser/browser';
import {IKeyboardEvent} from 'vs/base/browser/keyboardEvent';
import {IEditorService} from 'vs/platform/editor/common/editor';
import {IMessageService} from 'vs/platform/message/common/message';
import {Range} from 'vs/editor/common/core/range';
import * as editorCommon from 'vs/editor/common/editorCommon';
import {IActionOptions, ServicesAccessor, EditorAction, CommonEditorRegistry} from 'vs/editor/common/editorCommonExtensions';
import {Location, DefinitionProviderRegistry} from 'vs/editor/common/modes';
import {ICodeEditor, IEditorMouseEvent, IMouseTarget} from 'vs/editor/browser/editorBrowser';
import {EditorBrowserRegistry} from 'vs/editor/browser/editorBrowserExtensions';
import {getDeclarationsAtPosition} from 'vs/editor/contrib/goToDeclaration/common/goToDeclaration';
import {ReferencesController} from 'vs/editor/contrib/referenceSearch/browser/referencesController';
import {ReferencesModel} from 'vs/editor/contrib/referenceSearch/browser/referencesModel';
import {IDisposable, dispose} from 'vs/base/common/lifecycle';
import {PeekContext} from 'vs/editor/contrib/zoneWidget/browser/peekViewWidget';
import {KbExpr} from 'vs/platform/keybinding/common/keybinding';

import ModeContextKeys = editorCommon.ModeContextKeys;
import EditorContextKeys = editorCommon.EditorContextKeys;

export class DefinitionActionConfig {

	constructor(
		public openToSide = false,
		public openInPeek = false,
		public filterCurrent = true
	) {
		//
	}
}

export class DefinitionAction extends EditorAction {

	private _configuration: DefinitionActionConfig;

	constructor(configuration: DefinitionActionConfig, opts:IActionOptions) {
		super(opts);
		this._configuration = configuration;
	}

	public run(accessor:ServicesAccessor, editor:editorCommon.ICommonCodeEditor): TPromise<void> {
		const messageService = accessor.get(IMessageService);
		const editorService = accessor.get(IEditorService);

		let model = editor.getModel();
		let pos = editor.getPosition();

		return getDeclarationsAtPosition(model, pos).then(references => {

			if (!references) {
				return;
			}

			// * remove falsy references
			// * remove reference at the current pos
			// * collapse ranges to start pos
			let result: Location[] = [];
			for (let i = 0; i < references.length; i++) {
				let reference = references[i];
				if (!reference) {
					continue;
				}
				let {uri, range} = reference;
				if (!this._configuration.filterCurrent
					|| uri.toString() !== model.uri.toString()
					|| !Range.containsPosition(range, pos)) {

					result.push({
						uri,
						range: Range.collapseToStart(range)
					});
				}
			}

			if (result.length === 0) {
				return;
			}

			return this._onResult(editorService, editor, new ReferencesModel(result));

		}, (err) => {
			// report an error
			messageService.show(Severity.Error, err);
			return false;
		});
	}

	private _onResult(editorService:IEditorService, editor:editorCommon.ICommonCodeEditor, model: ReferencesModel) {
		if (this._configuration.openInPeek) {
			this._openInPeek(editorService, editor, model);
		} else {
			let next = model.nearestReference(editor.getModel().uri, editor.getPosition());
			this._openReference(editorService, next, this._configuration.openToSide).then(editor => {
				if (model.references.length > 1) {
					this._openInPeek(editorService, editor, model);
				}
			});
		}
	}

	private _openReference(editorService:IEditorService, reference: Location, sideBySide: boolean): TPromise<editorCommon.ICommonCodeEditor>{
		let {uri, range} = reference;
		return editorService.openEditor({
			resource: uri,
			options: {
				selection: range,
				revealIfVisible: !sideBySide
			}
		}, sideBySide).then(editor => {
			return <editorCommon.IEditor> editor.getControl();
		});
	}

	private _openInPeek(editorService:IEditorService, target: editorCommon.ICommonCodeEditor, model: ReferencesModel) {
		let controller = ReferencesController.getController(target);
		controller.toggleWidget(target.getSelection(), TPromise.as(model), {
			getMetaTitle: (model) => {
				return model.references.length > 1 && nls.localize('meta.title', " – {0} definitions", model.references.length);
			},
			onGoto: (reference) => {
				controller.closeWidget();
				return this._openReference(editorService, reference, false);
			}
		});
	}
}

const goToDeclarationKb = platform.isWeb
	? KeyMod.CtrlCmd | KeyCode.F12
	: KeyCode.F12;

export class GoToDefinitionAction extends DefinitionAction {

	public static ID = 'editor.action.goToDeclaration';

	constructor() {
		super(new DefinitionActionConfig(), {
			id: GoToDefinitionAction.ID,
			label: nls.localize('actions.goToDecl.label', "Go to Definition"),
			alias: 'Go to Definition',
			precondition: ModeContextKeys.hasDefinitionProvider,
			kbOpts: {
				kbExpr: EditorContextKeys.TextFocus,
				primary: goToDeclarationKb
			},
			menuOpts: {
				group: 'navigation',
				order: 1.1
			}
		});
	}
}

export class OpenDefinitionToSideAction extends DefinitionAction {

	public static ID = 'editor.action.openDeclarationToTheSide';

	constructor() {
		super(new DefinitionActionConfig(true), {
			id: OpenDefinitionToSideAction.ID,
			label: nls.localize('actions.goToDeclToSide.label', "Open Definition to the Side"),
			alias: 'Open Definition to the Side',
			precondition: ModeContextKeys.hasDefinitionProvider,
			kbOpts: {
				kbExpr: EditorContextKeys.TextFocus,
				primary: KeyMod.chord(KeyMod.CtrlCmd | KeyCode.KEY_K, goToDeclarationKb)
			}
		});
	}
}

export class PeekDefinitionAction extends DefinitionAction {
	constructor() {
		super(new DefinitionActionConfig(void 0, true, false), {
			id: 'editor.action.previewDeclaration',
			label: nls.localize('actions.previewDecl.label', "Peek Definition"),
			alias: 'Peek Definition',
			precondition: KbExpr.and(ModeContextKeys.hasDefinitionProvider, PeekContext.notInPeekEditor),
			kbOpts: {
				kbExpr: EditorContextKeys.TextFocus,
				primary: KeyMod.Alt | KeyCode.F12,
				linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F10 }
			},
			menuOpts: {
				group: 'navigation',
				order: 1.2
			}
		});
	}
}

// --- Editor Contribution to goto definition using the mouse and a modifier key

class GotoDefinitionWithMouseEditorContribution implements editorCommon.IEditorContribution {

	private static ID = 'editor.contrib.gotodefinitionwithmouse';
	static TRIGGER_MODIFIER = platform.isMacintosh ? 'metaKey' : 'ctrlKey';
	static TRIGGER_SIDEBYSIDE_KEY_VALUE = KeyCode.Alt;
	static TRIGGER_KEY_VALUE = platform.isMacintosh ? KeyCode.Meta : KeyCode.Ctrl;
	static MAX_SOURCE_PREVIEW_LINES = 7;

	private editor: ICodeEditor;
	private toUnhook: IDisposable[];
	private decorations: string[];
	private currentWordUnderMouse: editorCommon.IWordAtPosition;
	private throttler: Throttler;
	private lastMouseMoveEvent: IEditorMouseEvent;
	private hasTriggerKeyOnMouseDown: boolean;

	constructor(
		editor: ICodeEditor,
		@IEditorService private editorService: IEditorService
	) {
		this.toUnhook = [];
		this.decorations = [];
		this.editor = editor;
		this.throttler = new Throttler();

		this.toUnhook.push(this.editor.onMouseDown((e: IEditorMouseEvent) => this.onEditorMouseDown(e)));
		this.toUnhook.push(this.editor.onMouseUp((e: IEditorMouseEvent) => this.onEditorMouseUp(e)));
		this.toUnhook.push(this.editor.onMouseMove((e: IEditorMouseEvent) => this.onEditorMouseMove(e)));
		this.toUnhook.push(this.editor.onKeyDown((e: IKeyboardEvent) => this.onEditorKeyDown(e)));
		this.toUnhook.push(this.editor.onKeyUp((e: IKeyboardEvent) => this.onEditorKeyUp(e)));

		this.toUnhook.push(this.editor.onDidChangeCursorSelection((e) => this.onDidChangeCursorSelection(e)));
		this.toUnhook.push(this.editor.onDidChangeModel((e) => this.resetHandler()));
		this.toUnhook.push(this.editor.onDidChangeModelContent(() => this.resetHandler()));
		this.toUnhook.push(this.editor.onDidScrollChange((e) => {
			if (e.scrollTopChanged || e.scrollLeftChanged) {
				this.resetHandler();
			}
		}));
	}

	private onDidChangeCursorSelection(e: editorCommon.ICursorSelectionChangedEvent): void {
		if (e.selection && e.selection.startColumn !== e.selection.endColumn) {
			this.resetHandler(); // immediately stop this feature if the user starts to select (https://github.com/Microsoft/vscode/issues/7827)
		}
	}

	private onEditorMouseMove(mouseEvent: IEditorMouseEvent, withKey?: IKeyboardEvent): void {
		this.lastMouseMoveEvent = mouseEvent;

		this.startFindDefinition(mouseEvent, withKey);
	}

	private startFindDefinition(mouseEvent: IEditorMouseEvent, withKey?: IKeyboardEvent): void {
		if (!this.isEnabled(mouseEvent, withKey)) {
			this.currentWordUnderMouse = null;
			this.removeDecorations();
			return;
		}

		// Find word at mouse position
		let position = mouseEvent.target.position;
		let word = position ? this.editor.getModel().getWordAtPosition(position) : null;
		if (!word) {
			this.currentWordUnderMouse = null;
			this.removeDecorations();
			return;
		}

		// Return early if word at position is still the same
		if (this.currentWordUnderMouse && this.currentWordUnderMouse.startColumn === word.startColumn && this.currentWordUnderMouse.endColumn === word.endColumn && this.currentWordUnderMouse.word === word.word) {
			return;
		}

		this.currentWordUnderMouse = word;

		// Find definition and decorate word if found
		let state = this.editor.captureState(editorCommon.CodeEditorStateFlag.Position, editorCommon.CodeEditorStateFlag.Value, editorCommon.CodeEditorStateFlag.Selection, editorCommon.CodeEditorStateFlag.Scroll);
		this.throttler.queue(() => {
			return state.validate(this.editor)
				? this.findDefinition(mouseEvent.target)
				: TPromise.as(null);

		}).then(results => {
			if (!results || !results.length || !state.validate(this.editor)) {
				this.removeDecorations();
				return;
			}

			// Multiple results
			if (results.length > 1) {
				this.addDecoration({
					startLineNumber: position.lineNumber,
					startColumn: word.startColumn,
					endLineNumber: position.lineNumber,
					endColumn: word.endColumn
				}, nls.localize('multipleResults', "Click to show the {0} definitions found.", results.length), false);
			}

			// Single result
			else {
				let result = results[0];
				this.editorService.resolveEditorModel({ resource: result.uri }).then(model => {
					let source: string;
					if (model && model.textEditorModel) {

						let from = Math.max(1, result.range.startLineNumber),
							to: number,
							editorModel: editorCommon.IModel;

						editorModel = <editorCommon.IModel>model.textEditorModel;

						// if we have a range, take that into consideration for the "to" position, otherwise fallback to MAX_SOURCE_PREVIEW_LINES
						if (result.range.startLineNumber !== result.range.endLineNumber || result.range.startColumn !== result.range.endColumn) {
							to = Math.min(result.range.endLineNumber, result.range.startLineNumber + GotoDefinitionWithMouseEditorContribution.MAX_SOURCE_PREVIEW_LINES, editorModel.getLineCount());
						} else {
							to = Math.min(from + GotoDefinitionWithMouseEditorContribution.MAX_SOURCE_PREVIEW_LINES, editorModel.getLineCount());
						}

						source = editorModel.getValueInRange({
							startLineNumber: from,
							startColumn: 1,
							endLineNumber: to,
							endColumn: editorModel.getLineMaxColumn(to)
						}).trim();

						// remove common leading whitespace
						let min = Number.MAX_VALUE,
							regexp = /^[ \t]*/,
							match: RegExpExecArray,
							contents: string;

						while (from <= to && min > 0) {
							contents = editorModel.getLineContent(from++);
							if (contents.trim().length === 0) {
								// empty or whitespace only
								continue;
							}
							match = regexp.exec(contents);
							min = Math.min(min, match[0].length);
						}

						source = source.replace(new RegExp(`^([ \\t]{${min}})`, 'gm'), strings.empty);

						if (result.range.endLineNumber - result.range.startLineNumber > GotoDefinitionWithMouseEditorContribution.MAX_SOURCE_PREVIEW_LINES) {
							source += '\n\u2026';
						}
					}

					this.addDecoration({
						startLineNumber: position.lineNumber,
						startColumn: word.startColumn,
						endLineNumber: position.lineNumber,
						endColumn: word.endColumn
					}, source, true);
				});
			}
		}).done(undefined, onUnexpectedError);
	}

	private addDecoration(range: editorCommon.IRange, text: string, isCode: boolean): void {
		let model = this.editor.getModel();
		if (!model) {
			return;
		}

		let hoverMessage: MarkedString = void 0;
		if (text && text.trim().length > 0) {
			if (isCode) {
				hoverMessage = {
					language: model.getMode().getId(),
					value: text
				};
			} else {
				hoverMessage = textToMarkedString(text);
			}
		}

		let newDecorations : editorCommon.IModelDeltaDecoration = {
			range: range,
			options: {
				inlineClassName: 'goto-definition-link',
				hoverMessage
			}
		};

		this.decorations = this.editor.deltaDecorations(this.decorations, [newDecorations]);
	}

	private removeDecorations(): void {
		if (this.decorations.length > 0) {
			this.decorations = this.editor.deltaDecorations(this.decorations, []);
		}
	}

	private onEditorKeyDown(e: IKeyboardEvent): void {
		if (
			this.lastMouseMoveEvent && (
				e.keyCode === GotoDefinitionWithMouseEditorContribution.TRIGGER_KEY_VALUE || // User just pressed Ctrl/Cmd (normal goto definition)
				e.keyCode === GotoDefinitionWithMouseEditorContribution.TRIGGER_SIDEBYSIDE_KEY_VALUE && e[GotoDefinitionWithMouseEditorContribution.TRIGGER_MODIFIER] // User pressed Ctrl/Cmd+Alt (goto definition to the side)
			)
		) {
			this.startFindDefinition(this.lastMouseMoveEvent, e);
		} else if (e[GotoDefinitionWithMouseEditorContribution.TRIGGER_MODIFIER]) {
			this.removeDecorations(); // remove decorations if user holds another key with ctrl/cmd to prevent accident goto declaration
		}
	}

	private resetHandler(): void {
		this.lastMouseMoveEvent = null;
		this.hasTriggerKeyOnMouseDown = false;
		this.removeDecorations();
	}

	private onEditorMouseDown(mouseEvent: IEditorMouseEvent): void {
		// We need to record if we had the trigger key on mouse down because someone might select something in the editor
		// holding the mouse down and then while mouse is down start to press Ctrl/Cmd to start a copy operation and then
		// release the mouse button without wanting to do the navigation.
		// With this flag we prevent goto definition if the mouse was down before the trigger key was pressed.
		this.hasTriggerKeyOnMouseDown = !!mouseEvent.event[GotoDefinitionWithMouseEditorContribution.TRIGGER_MODIFIER];
	}

	private onEditorMouseUp(mouseEvent: IEditorMouseEvent): void {
		if (this.isEnabled(mouseEvent) && this.hasTriggerKeyOnMouseDown) {
			this.gotoDefinition(mouseEvent.target, mouseEvent.event.altKey).done(() => {
				this.removeDecorations();
			}, (error: Error) => {
				this.removeDecorations();
				onUnexpectedError(error);
			});
		}
	}

	private onEditorKeyUp(e: IKeyboardEvent): void {
		if (e.keyCode === GotoDefinitionWithMouseEditorContribution.TRIGGER_KEY_VALUE) {
			this.removeDecorations();
			this.currentWordUnderMouse = null;
		}
	}

	private isEnabled(mouseEvent: IEditorMouseEvent, withKey?: IKeyboardEvent): boolean {
		return this.editor.getModel() &&
			(browser.isIE11orEarlier || mouseEvent.event.detail <= 1) && // IE does not support event.detail properly
			mouseEvent.target.type === editorCommon.MouseTargetType.CONTENT_TEXT &&
			(mouseEvent.event[GotoDefinitionWithMouseEditorContribution.TRIGGER_MODIFIER] || (withKey && withKey.keyCode === GotoDefinitionWithMouseEditorContribution.TRIGGER_KEY_VALUE)) &&
			DefinitionProviderRegistry.has(this.editor.getModel());
	}

	private findDefinition(target: IMouseTarget): TPromise<Location[]> {
		let model = this.editor.getModel();
		if (!model) {
			return TPromise.as(null);
		}

		return getDeclarationsAtPosition(this.editor.getModel(), target.position);
	}

	private gotoDefinition(target: IMouseTarget, sideBySide: boolean): TPromise<any> {

		const targetAction = sideBySide
			? OpenDefinitionToSideAction.ID
			: GoToDefinitionAction.ID;

		// just run the corresponding action
		this.editor.setPosition(target.position);
		return this.editor.getAction(targetAction).run();
	}

	public getId(): string {
		return GotoDefinitionWithMouseEditorContribution.ID;
	}

	public dispose(): void {
		this.toUnhook = dispose(this.toUnhook);
	}
}

// register actions

CommonEditorRegistry.registerEditorAction(new PeekDefinitionAction());
CommonEditorRegistry.registerEditorAction(new GoToDefinitionAction());
CommonEditorRegistry.registerEditorAction(new OpenDefinitionToSideAction());

EditorBrowserRegistry.registerEditorContribution(GotoDefinitionWithMouseEditorContribution);
