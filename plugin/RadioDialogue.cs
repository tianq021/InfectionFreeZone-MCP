using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using CallSystem.Runtime.DialogueSystem.UI;
using DialogueSystem.Runtime.Core;
using DialogueSystem.Runtime.Core.UI;
using DialogueSystem.Runtime.Core.UI.Text;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using TMPro;
using TransmissionSystem;
using TransmissionSystem.UI;
using UnityEngine.UI;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static TransmissionManager radio;
    private static TransmissionCanvas radioCanvas;
    private static DialogueManager dialogueManager;
    private static readonly AccessTools.FieldRef<DialoguePanel, List<DialogueOption>> RadioOptions =
        AccessTools.FieldRefAccess<DialoguePanel, List<DialogueOption>>("_activeDialogueOptions");
    private static readonly AccessTools.FieldRef<DialogueOption, bool> RadioClickable =
        AccessTools.FieldRefAccess<DialogueOption, bool>("_clickable");
    private static readonly AccessTools.FieldRef<TextPrinter, TextMeshProUGUI> RadioText =
        AccessTools.FieldRefAccess<TextPrinter, TextMeshProUGUI>("_textMesh");
    private static readonly AccessTools.FieldRef<TransmissionManager, bool> RadioPause =
        AccessTools.FieldRefAccess<TransmissionManager, bool>("_isPausingGameplayTransmissionStarted");

    private Dialogue radioDialogue;
    private DialogueOption[] radioOptions = Array.Empty<DialogueOption>();
    private Guid radioChoiceId;
    private bool radioChoiceConsumed;
    private RadioSelection lastRadioSelection;

    private static bool RadioOwnsPause() => radio != null && RadioPause(radio);

    private static void CaptureRadio(TransmissionManager __instance, TransmissionCanvas __0, DialogueManager __1)
    {
        radio = __instance;
        radioCanvas = __0;
        dialogueManager = __1;
    }

    private void ResetRadioChoice()
    {
        radioDialogue = null;
        radioOptions = Array.Empty<DialogueOption>();
        radioChoiceId = Guid.Empty;
        radioChoiceConsumed = false;
    }

    private void ClearRadioSelection()
    {
        if (lastRadioSelection == null) return;
        StopRadioObservation();
        lastRadioSelection = null;
    }

    private void StopRadioObservation()
    {
        lastRadioSelection.Manager.OnLinePlayed -= RecordRadioLine;
        lastRadioSelection.Manager.OnDialogueEnded -= EndRadioObservation;
    }

    private void RecordRadioLine(DialogueLine line)
    {
        var selection = lastRadioSelection;
        if (selection == null || line?.Text == null ||
            !ReferenceEquals(selection.Manager.CurrentDialogue, selection.Dialogue)) return;
        try
        {
            selection.Lines.Enqueue(new { speaker = line.Speaker.ToString(), text = PlainRadioText(line.GetText()) });
            if (selection.Lines.Count > 30) selection.Lines.Dequeue();
        }
        catch (Exception ex)
        {
            Logger.LogWarning("Could not record a radio line: " + ex.Message);
        }
    }

    private void EndRadioObservation(Dialogue dialogue)
    {
        if (lastRadioSelection == null || !ReferenceEquals(lastRadioSelection.Dialogue, dialogue)) return;
        lastRadioSelection.Ended = true;
        StopRadioObservation();
    }

    private bool RefreshRadioChoice()
    {
        var dialogue = dialogueManager?.CurrentDialogue;
        var panel = dialogueManager?.DialoguePanel;
        if (radio == null || radioCanvas == null || !radioCanvas.gameObject.activeInHierarchy ||
            !radioCanvas.TransmissionPanelAnimator.PanelState || radioCanvas.TransmissionLogShower.IsActive ||
            radio.IsTransmissionStarting || string.IsNullOrEmpty(radio.ActiveDialogueId) || dialogue == null || panel == null ||
            !panel.gameObject.activeInHierarchy)
        {
            ResetRadioChoice();
            return false;
        }

        var options = RadioOptions(panel).Where(option => option != null && option.isActiveAndEnabled &&
            option.DialogueLine?.IsActive == true).ToArray();
        if (!ReferenceEquals(dialogue, radioDialogue) || !radioOptions.SequenceEqual(options))
        {
            radioDialogue = dialogue;
            radioOptions = options;
            radioChoiceId = options.Length == 0 ? Guid.Empty : Guid.NewGuid();
            radioChoiceConsumed = false;
        }
        return true;
    }

    private static bool IsRadioButtonEnabled(DialogueOption option)
    {
        var button = option.GetComponent<Button>();
        return button != null && button.IsActive() && button.IsInteractable();
    }

    private bool RadioChoiceReady() => !radioChoiceConsumed && !pauses.IsPopupPaused &&
        radioOptions.Any(IsRadioButtonEnabled) &&
        radioOptions.All(option => !IsRadioButtonEnabled(option) || RadioClickable(option));

    private static string PlainRadioText(string value) =>
        Regex.Replace(value ?? "", @"</?(?:color|b|i|size|link|alpha|sprite|u|s)(?:[ =][^>]*)?>", "", RegexOptions.IgnoreCase);

    private static object RadioOptionInfo(DialogueOption option, int index, bool selectable)
    {
        var line = option.DialogueLine;
        var hints = line.providedContent.Select(content => new
        {
            keys = (content.Content ?? "").Split(';').Select(key => key.Trim()).ToArray(),
            alternatives = content.Id != 0,
            value = content.Value,
            percent = content.IsPercentageValue
        }).ToArray();
        return new
        {
            option_id = index + 1,
            text = PlainRadioText(line.GetDialogOptionText()),
            full_text = PlainRadioText(line.GetText()),
            selectable,
            ends_call = line.IsLast,
            effect_hints = hints
        };
    }

    private object ReadRadioDialogue()
    {
        if (!RefreshRadioChoice()) return null;
        var textMesh = RadioText(dialogueManager.DialoguePanel.TextPrinter);
        var text = textMesh != null && textMesh.gameObject.activeInHierarchy ? textMesh.GetParsedText() ?? "" : "";
        var visible = textMesh == null ? 0 : Math.Min(text.Length, textMesh.maxVisibleCharacters);
        if (visible < text.Length && visible > 0 && char.IsHighSurrogate(text[visible - 1])) visible--;
        var start = Math.Max(0, visible - 6000);
        if (start < visible && char.IsLowSurrogate(text[start])) start++;
        var ready = RadioChoiceReady();
        return new
        {
            transmission_id = radio.ActiveDialogueId,
            text = text.Substring(start, visible - start),
            text_truncated = start > 0,
            choice_id = ready ? (Guid?)radioChoiceId : null,
            options = ready
                ? radioOptions.Select((option, i) => RadioOptionInfo(option, i, IsRadioButtonEnabled(option))).ToArray()
                : Array.Empty<object>()
        };
    }

    private object ReadRadioDialogueReply() => new
    {
        session_id = sessionId,
        dialogue = ReadRadioDialogue(),
        last_choice = lastRadioSelection == null ? null : new
        {
            receipt = lastRadioSelection.Receipt,
            ended = lastRadioSelection.Ended,
            observed_lines = lastRadioSelection.Lines.ToArray()
        }
    };

    private object ChooseRadioOption(JObject args)
    {
        var choiceId = Id(args, "choice_id");
        var optionId = (int?)args["option_id"];
        if (!RefreshRadioChoice() || !RadioChoiceReady() || choiceId != radioChoiceId)
            throw new BridgeException("stale_dialogue_choice", "Read the active radio dialogue again before choosing.");
        if (!optionId.HasValue || optionId.Value < 1 || optionId.Value > radioOptions.Length)
            throw new BridgeException("invalid_dialogue_option", "Use an option_id from the current radio choice.");
        var option = radioOptions[optionId.Value - 1];
        if (!IsRadioButtonEnabled(option) || !RadioClickable(option))
            throw new BridgeException("dialogue_option_unavailable", "The radio option is no longer selectable.");
        var selected = RadioOptionInfo(option, optionId.Value - 1, true);
        var transmissionId = radio.ActiveDialogueId;
        var receipt = new { state = "selected", session_id = sessionId, choice_id = choiceId, request_id = Id(args, "request_id"),
            transmission_id = transmissionId, option = selected };
        ClearRadioSelection();
        var selection = new RadioSelection(dialogueManager, radioDialogue);
        lastRadioSelection = selection;
        dialogueManager.OnLinePlayed += RecordRadioLine;
        dialogueManager.OnDialogueEnded += EndRadioObservation;
        // Invoke the real option button once. It owns progression, game effects and pause recovery.
        radioChoiceConsumed = true;
        option.GetComponent<Button>().onClick.Invoke();
        selection.Receipt = receipt;
        return receipt;
    }

    private sealed class RadioSelection
    {
        public readonly DialogueManager Manager;
        public readonly Dialogue Dialogue;
        public readonly Queue<object> Lines = new();
        public object Receipt;
        public bool Ended;

        public RadioSelection(DialogueManager manager, Dialogue dialogue)
        {
            Manager = manager;
            Dialogue = dialogue;
        }
    }
}
