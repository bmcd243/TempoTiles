import "react-native-gesture-handler";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import DraggableFlatList, {
  RenderItemParams,
} from "react-native-draggable-flatlist";
import { parseIntervals } from "./src/parser";
import { IntervalBlock, IntervalStep } from "./src/types";
import { SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseIntervalsAI, transcribeAudio } from "./src/openai";
import {
  ensureOnDeviceModel,
  isOnDeviceModuleAvailable,
  runOnDeviceParse,
} from "./src/localModel";

const EXAMPLE =
  "10 minutes jog followed by 8 sets of 30 seconds sprint followed by 90 seconds jog, finishing with a 10 minute jog";

const STORAGE_KEY = "interval_sessions_v1";
const LOCAL_MODEL_URL =
  "https://huggingface.co/yacht/Llama-3.2-1B-Instruct-CoreML/resolve/main/model.mlmodel";

type SavedSession = {
  id: string;
  name: string;
  input: string;
  blocks: IntervalBlock[];
  createdAt: string;
};

const PRESETS = [
  {
    name: "5K Speed Builder",
    input:
      "10 minutes easy jog, then 6 sets of 30 seconds sprint followed by 90 seconds jog, finishing with 5 minutes easy jog",
  },
  {
    name: "HIIT Ladder",
    input:
      "5 minutes warmup jog, then 4 sets of 45 seconds hard followed by 60 seconds jog, then 4 sets of 30 seconds sprint followed by 60 seconds jog, finishing with 5 minutes easy jog",
  },
  {
    name: "Tempo Blocks",
    input:
      "8 minutes easy jog, then 3 sets of 3 minutes tempo followed by 2 minutes jog, finishing with 6 minutes easy jog",
  },
];

function formatDuration(seconds: number) {
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs === 0 ? `${mins} min` : `${mins} min ${secs} sec`;
  }
  return `${seconds} sec`;
}

export default function App() {
  const [input, setInput] = useState(EXAMPLE);
  const [blocks, setBlocks] = useState<IntervalBlock[]>(() =>
    parseIntervals(EXAMPLE)
  );
  const [selected, setSelected] = useState<IntervalBlock | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editDuration, setEditDuration] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [activeSet, setActiveSet] = useState<IntervalBlock | null>(null);
  const [setItems, setSetItems] = useState<IntervalStep[]>([]);
  const [setRepeat, setSetRepeat] = useState("1");
  const [screen, setScreen] = useState<"builder" | "runner" | "saved">("builder");
  const [useLocalModel, setUseLocalModel] = useState(true);
  const [localBaseUrl, setLocalBaseUrl] = useState("http://localhost:11434/v1");
  const [localModel, setLocalModel] = useState("llama3.1:8b-instruct");
  const [useOnDeviceModel, setUseOnDeviceModel] = useState(true);
  const [isModelReady, setIsModelReady] = useState(isOnDeviceModuleAvailable);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [isCountingDown, setIsCountingDown] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [remainingSec, setRemainingSec] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulse = useRef(new Animated.Value(0)).current;
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSpokenSecondRef = useRef<number | null>(null);
  const lastSpokenIndexRef = useRef<number | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [saveName, setSaveName] = useState("");

  const totalSeconds = useMemo(() => {
    return blocks.reduce((sum, block) => {
      if (block.type === "interval") return sum + block.durationSec;
      const setDuration = block.items.reduce((acc, item) => acc + item.durationSec, 0);
      return sum + setDuration * block.repeat;
    }, 0);
  }, [blocks]);

  const runSequence = useMemo(() => {
    const sequence: IntervalStep[] = [];
    blocks.forEach((block) => {
      if (block.type === "interval") {
        sequence.push({
          id: block.id,
          label: block.label,
          durationSec: block.durationSec,
        });
        return;
      }
      for (let r = 1; r <= block.repeat; r += 1) {
        block.items.forEach((item, idx) => {
          sequence.push({
            id: `${block.id}_${r}_${idx}`,
            label: `${item.label} (Set ${r} of ${block.repeat})`,
            durationSec: item.durationSec,
          });
        });
      }
    });
    return sequence;
  }, [blocks]);

  const loadSavedSessions = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setSavedSessions(parsed);
      }
    } catch (err) {
      setError("Failed to load saved sessions.");
    }
  };

  const persistSavedSessions = async (sessions: SavedSession[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (err) {
      setError("Failed to save session.");
    }
  };

  useEffect(() => {
    loadSavedSessions();
  }, []);

  const openEdit = (block: IntervalBlock) => {
    if (block.type === "set") {
      setActiveSet(block);
      setSetItems(block.items.map((item) => ({ ...item })));
      setSetRepeat(String(block.repeat));
      return;
    }
    setSelected(block);
    setEditLabel(block.label);
    setEditDuration(String(block.durationSec));
  };

  const saveEdit = () => {
    if (!selected || selected.type !== "interval") return;
    const durationSec = Math.max(1, Number(editDuration) || selected.durationSec);
    setBlocks((prev) =>
      prev.map((item) =>
        item.id === selected.id
          ? { ...item, label: editLabel.trim() || item.label, durationSec }
          : item
      )
    );
    setSelected(null);
  };

  const saveSetEdit = () => {
    if (!activeSet || activeSet.type !== "set") return;
    const repeat = Math.max(1, Number(setRepeat) || activeSet.repeat);
    setBlocks((prev) =>
      prev.map((block) =>
        block.id === activeSet.id
          ? {
              ...block,
              repeat,
              items: setItems.map((item) => ({
                ...item,
                label: item.label.trim() || "Interval",
                durationSec: Math.max(1, Math.round(item.durationSec)),
              })),
            }
          : block
      )
    );
    setActiveSet(null);
  };

  const saveSession = async () => {
    const name = saveName.trim() || `Session ${new Date().toLocaleDateString()}`;
    const newSession: SavedSession = {
      id: `session_${Date.now()}`,
      name,
      input,
      blocks,
      createdAt: new Date().toISOString(),
    };
    const next = [newSession, ...savedSessions];
    setSavedSessions(next);
    await persistSavedSessions(next);
    setSaveName("");
    setScreen("saved");
  };

  const downloadOnDeviceModel = async () => {
    setError(null);
    if (!isOnDeviceModuleAvailable) {
      setIsModelReady(true);
      return;
    }
    setIsDownloadingModel(true);
    try {
      await ensureOnDeviceModel(LOCAL_MODEL_URL);
      setIsModelReady(true);
    } catch (err) {
      setError((err as Error).message || "Failed to download model.");
    } finally {
      setIsDownloadingModel(false);
    }
  };

  const loadSession = (session: SavedSession) => {
    setInput(session.input);
    setBlocks(session.blocks);
    setScreen("builder");
  };

  const deleteSession = async (sessionId: string) => {
    const next = savedSessions.filter((session) => session.id !== sessionId);
    setSavedSessions(next);
    await persistSavedSessions(next);
  };

  const handleParse = async () => {
    await handleParseWithText(input);
  };

  const applyPreset = (presetInput: string) => {
    setInput(presetInput);
    handleParseWithText(presetInput);
  };

  const handleParseWithText = async (text: string) => {
    setError(null);
    if (!text.trim()) {
      setBlocks([]);
      return;
    }
    if (useOnDeviceModel && !isOnDeviceModuleAvailable) {
      setBlocks(parseIntervals(text));
      return;
    }
    if (useOnDeviceModel && !isModelReady) {
      setError("On-device model not downloaded yet.");
      return;
    }
    if (!useOnDeviceModel && useLocalModel && (!localBaseUrl.trim() || !localModel.trim())) {
      setError("Local model settings are incomplete.");
      return;
    }
    setIsParsing(true);
    try {
      const aiBlocks = useOnDeviceModel
        ? await runOnDeviceParse(text)
        : await parseIntervalsAI(text, {
            baseUrl: useLocalModel ? localBaseUrl : undefined,
            model: useLocalModel ? localModel : undefined,
          });
      setBlocks(aiBlocks);
    } catch (err) {
      setError(
        (err as Error).message ||
          "AI parsing unavailable. Falling back to offline parser."
      );
      setBlocks(parseIntervals(text));
    } finally {
      setIsParsing(false);
    }
  };

  const startRecording = async () => {
    setError(null);
    if (useOnDeviceModel || useLocalModel) {
      setError("Voice input requires the OpenAI API. Disable local/on-device mode to use voice.");
      return;
    }
    const permission = await Audio.requestPermissionsAsync();
    if (permission.status !== "granted") {
      setError("Microphone permission denied.");
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    const { recording: newRecording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    setRecording(newRecording);
  };

  const stopRecording = async () => {
    if (!recording) return;
    setIsTranscribing(true);
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      if (uri) {
        const text = await transcribeAudio(uri);
        setInput(text);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsTranscribing(false);
    }
  };

  const startWorkout = () => {
    if (!runSequence.length) return;
    setError(null);
    setCurrentIndex(0);
    setRemainingSec(runSequence[0].durationSec);
    setIsRunning(false);
    setIsPaused(false);
    setCountdown(3);
    setIsCountingDown(true);
    lastSpokenSecondRef.current = null;
    lastSpokenIndexRef.current = null;
    setScreen("runner");
  };

  const stopWorkout = () => {
    setIsRunning(false);
    setIsPaused(false);
    setIsCountingDown(false);
    setCurrentIndex(0);
    setRemainingSec(0);
    lastSpokenSecondRef.current = null;
    lastSpokenIndexRef.current = null;
    setScreen("builder");
  };

  const togglePause = () => {
    if (!isRunning) return;
    setIsPaused((prev) => !prev);
  };

  const advanceInterval = () => {
    setCurrentIndex((prev) => {
      const next = prev + 1;
      if (next >= runSequence.length) {
        stopWorkout();
        return prev;
      }
      lastSpokenSecondRef.current = null;
      setRemainingSec(runSequence[next].durationSec);
      return next;
    });
  };

  const speak = (text: string) => {
    try {
      Speech.speak(text, { rate: 0.95 });
    } catch (err) {
      // ignore speech errors
    }
  };

  const speakCountdown = (value: number) => {
    if (value > 0) {
      speak(String(value));
    } else if (value === 0) {
      speak("Go");
    }
  };

  useEffect(() => {
    if (!isRunning || isPaused) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setInterval(() => {
      setRemainingSec((prev) => {
        if (prev <= 3 && prev > 0) {
          if (lastSpokenSecondRef.current !== prev) {
            speak(String(prev));
            lastSpokenSecondRef.current = prev;
          }
        }
        if (prev <= 1) {
          advanceInterval();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isRunning, isPaused, runSequence.length]);

  useEffect(() => {
    if (!isCountingDown) {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }
    speakCountdown(countdown);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        const next = prev - 1;
        if (next >= 0) {
          speakCountdown(next);
        }
        if (next <= 0) {
          setIsCountingDown(false);
          setIsRunning(true);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, [isCountingDown]);

  useEffect(() => {
    if (!isRunning) return;
    if (lastSpokenIndexRef.current === currentIndex) return;
    const step = runSequence[currentIndex];
    if (step) {
      speak(step.label);
      lastSpokenIndexRef.current = currentIndex;
    }
  }, [isRunning, currentIndex, runSequence]);

  useEffect(() => {
    if (screen !== "runner" || !isRunning || isPaused) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [screen, isRunning, isPaused, pulse]);

  useEffect(() => {
    if (isRunning) {
      stopWorkout();
    }
  }, [runSequence.length]);

  const renderItem = ({
    item,
    drag,
    isActive,
  }: RenderItemParams<IntervalBlock>) => {
    const isCurrent =
      screen === "runner" &&
      runSequence[currentIndex] &&
      item.type === "interval" &&
      runSequence[currentIndex].label.startsWith(item.label);
    const totalDuration =
      item.type === "interval"
        ? item.durationSec
        : item.items.reduce((sum, step) => sum + step.durationSec, 0) * item.repeat;
    return (
      <Pressable
        onLongPress={!isRunning ? drag : undefined}
        onPress={() => openEdit(item)}
        style={[
          styles.card,
          isActive && styles.cardActive,
          isCurrent && styles.cardCurrent,
        ]}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.label}</Text>
          <Text style={styles.cardTime}>{formatDuration(totalDuration)}</Text>
        </View>
        {item.type === "set" && (
          <Text style={styles.cardMeta}>
            {item.repeat} sets • {item.items.length} intervals each
          </Text>
        )}
        <Text style={styles.cardHint}>Tap to edit. Long press to drag.</Text>
      </Pressable>
    );
  };

  const currentStep = runSequence[currentIndex];

  if (screen === "runner") {
    const pulseScale = pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 1.15],
    });
    const showCountdown = isCountingDown && countdown > 0;
    return (
      <GestureHandlerRootView style={styles.safe}>
        <SafeAreaView style={styles.runnerScreen}>
          <StatusBar barStyle="dark-content" />
          <View style={styles.runnerHeader}>
            <Pressable style={styles.ghostButton} onPress={stopWorkout}>
              <Text style={styles.ghostButtonText}>Back</Text>
            </Pressable>
            <Text style={styles.runnerTitle}>Workout</Text>
            <Pressable
              style={[
                styles.secondaryButton,
                isCountingDown && styles.buttonDisabled,
              ]}
              onPress={togglePause}
              disabled={isCountingDown}
            >
              <Text style={styles.secondaryButtonText}>
                {isPaused ? "Resume" : "Pause"}
              </Text>
            </Pressable>
          </View>

          <View style={styles.timerWrap}>
            <Animated.View
              style={[
                styles.timerPulse,
                {
                  transform: [{ scale: pulseScale }],
                  opacity: isPaused || isCountingDown ? 0.4 : 0.9,
                },
              ]}
            />
            <View style={styles.timerCore}>
              <Text style={styles.timerLabel}>
                {showCountdown ? "Starting in" : "Time Left"}
              </Text>
              <Text style={styles.timerText}>
                {showCountdown ? `${countdown}` : formatDuration(remainingSec)}
              </Text>
            </View>
          </View>

          <View style={styles.runnerInfo}>
            <Text style={styles.nowLabel}>Current interval</Text>
            <Text style={styles.runnerActivity}>
              {currentStep ? currentStep.label : "Finished"}
            </Text>
          </View>

          <View style={styles.runnerFooter}>
            <Pressable style={styles.ghostButton} onPress={stopWorkout}>
              <Text style={styles.ghostButtonText}>Stop workout</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  if (screen === "saved") {
    return (
      <GestureHandlerRootView style={styles.safe}>
        <SafeAreaView style={styles.safe}>
          <StatusBar barStyle="dark-content" />
          <View style={styles.savedHeader}>
            <Pressable style={styles.ghostButton} onPress={() => setScreen("builder")}>
              <Text style={styles.ghostButtonText}>Back</Text>
            </Pressable>
            <Text style={styles.runnerTitle}>Saved Sessions</Text>
          </View>
          <View style={styles.savedList}>
            {savedSessions.length === 0 && (
              <Text style={styles.noteText}>No saved sessions yet.</Text>
            )}
            {savedSessions.map((session) => (
              <View key={session.id} style={styles.savedCard}>
                <Text style={styles.savedTitle}>{session.name}</Text>
                <Text style={styles.savedSubtitle} numberOfLines={2}>
                  {session.input}
                </Text>
                <View style={styles.savedActions}>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => loadSession(session)}
                  >
                    <Text style={styles.secondaryButtonText}>Load</Text>
                  </Pressable>
                  <Pressable
                    style={styles.ghostButton}
                    onPress={() => deleteSession(session.id)}
                  >
                    <Text style={styles.ghostButtonText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.safe}>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" />
        <DraggableFlatList
          data={blocks}
          onDragEnd={({ data }) => setBlocks(data)}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          activationDistance={12}
          containerStyle={styles.list}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <>
              <View style={styles.hero}>
                <Text style={styles.title}>TempoTiles</Text>
                <Text style={styles.subtitle}>
                  Describe your workout in plain language and turn it into draggable
                  intervals.
                </Text>
              </View>

              <View style={styles.inputBlock}>
                <Text style={styles.label}>Natural language input</Text>
                <TextInput
                  style={styles.input}
                  multiline
                  value={input}
                  onChangeText={setInput}
                  placeholder="Type your session..."
                  placeholderTextColor="#6f6b60"
                />
                <View style={styles.toggleRow}>
                  <View style={styles.toggleItem}>
                    <Text style={styles.toggleLabel}>AI parsing</Text>
                    <Text style={styles.toggleValue}>Always on</Text>
                  </View>
                  <View style={styles.toggleItem}>
                    <Text style={styles.toggleLabel}>On-device model</Text>
                    <Pressable
                      style={[
                        styles.voiceButton,
                        useOnDeviceModel && styles.voiceButtonActive,
                      ]}
                      onPress={() => setUseOnDeviceModel((prev) => !prev)}
                    >
                      <Text
                        style={[
                          styles.voiceButtonText,
                          useOnDeviceModel && styles.voiceButtonTextActive,
                        ]}
                      >
                        {useOnDeviceModel ? "On" : "Off"}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.toggleItem}>
                    <Text style={styles.toggleLabel}>Local model</Text>
                    <Pressable
                      style={[
                        styles.voiceButton,
                        useLocalModel && styles.voiceButtonActive,
                      ]}
                      onPress={() => setUseLocalModel((prev) => !prev)}
                    >
                      <Text
                        style={[
                          styles.voiceButtonText,
                          useLocalModel && styles.voiceButtonTextActive,
                        ]}
                      >
                        {useLocalModel ? "On" : "Off"}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.toggleItem}>
                    <Text style={styles.toggleLabel}>Voice input</Text>
                    <Pressable
                      style={[
                        styles.voiceButton,
                        recording && styles.voiceButtonActive,
                        isTranscribing && styles.voiceButtonDisabled,
                        (useOnDeviceModel || useLocalModel) && styles.voiceButtonDisabled,
                      ]}
                      onPress={recording ? stopRecording : startRecording}
                      disabled={isTranscribing || useOnDeviceModel || useLocalModel}
                    >
                      <Text
                        style={[
                          styles.voiceButtonText,
                          (recording || useOnDeviceModel || useLocalModel) &&
                            styles.voiceButtonTextActive,
                        ]}
                      >
                        {recording ? "Stop" : "Record"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
                {useOnDeviceModel ? (
                  <>
                    <Text style={styles.noteText}>
                      On-device model requires a one-time download.
                    </Text>
                    <View style={styles.localRow}>
                      <Pressable
                        style={[
                          styles.primaryButton,
                          isDownloadingModel && styles.buttonDisabled,
                        ]}
                        onPress={downloadOnDeviceModel}
                        disabled={isDownloadingModel}
                      >
                        <Text style={styles.primaryButtonText}>
                          {isModelReady
                            ? "Model ready"
                            : isDownloadingModel
                            ? "Downloading..."
                            : "Download model"}
                        </Text>
                      </Pressable>
                    </View>
                  </>
                ) : useLocalModel ? (
                  <>
                    <Text style={styles.noteText}>
                      Local model is enabled. Enter your local server settings below.
                    </Text>
                    <View style={styles.localRow}>
                      <TextInput
                        style={styles.localInput}
                        value={localBaseUrl}
                        onChangeText={setLocalBaseUrl}
                        placeholder="http://localhost:11434/v1"
                        placeholderTextColor="#8a7f6b"
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <TextInput
                        style={styles.localInput}
                        value={localModel}
                        onChangeText={setLocalModel}
                        placeholder="llama3.1:8b-instruct"
                        placeholderTextColor="#8a7f6b"
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </View>
                    <Text style={styles.noteText}>
                      Voice input is disabled in local mode.
                    </Text>
                  </>
                ) : (
                  <Text style={styles.noteText}>
                    AI parsing uses the OpenAI API and may incur usage charges.
                  </Text>
                )}
                {(isTranscribing || isParsing) && (
                  <View style={styles.statusRow}>
                    <ActivityIndicator color="#2a2620" />
                    <Text style={styles.statusText}>
                      {isTranscribing
                        ? "Transcribing audio..."
                        : "Parsing with AI..."}
                    </Text>
                  </View>
                )}
                {error && <Text style={styles.errorText}>{error}</Text>}
                <View style={styles.actions}>
                  <Pressable
                    style={[
                      styles.primaryButton,
                      isParsing && styles.buttonDisabled,
                    ]}
                    onPress={handleParse}
                    disabled={isParsing}
                  >
                    <Text style={styles.primaryButtonText}>Parse intervals</Text>
                  </Pressable>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => {
                      setInput(EXAMPLE);
                      setBlocks(parseIntervals(EXAMPLE));
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>Use example</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.presetsBlock}>
                <Text style={styles.label}>Preset templates</Text>
                <View style={styles.presetsRow}>
                  {PRESETS.map((preset) => (
                    <Pressable
                      key={preset.name}
                      style={styles.presetCard}
                      onPress={() => applyPreset(preset.input)}
                    >
                      <Text style={styles.presetTitle}>{preset.name}</Text>
                      <Text style={styles.presetSubtitle} numberOfLines={2}>
                        {preset.input}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.summaryRow}>
                <Text style={styles.summaryText}>
                  {blocks.length} blocks • {runSequence.length} intervals
                </Text>
                <Text style={styles.summaryText}>
                  Total {formatDuration(totalSeconds)}
                </Text>
              </View>

              <View style={styles.controlsBlock}>
                <Text style={styles.label}>Workout controls</Text>
                <View style={styles.controlsRow}>
                  <Pressable
                    style={styles.primaryButton}
                    onPress={startWorkout}
                  >
                    <Text style={styles.primaryButtonText}>Start</Text>
                  </Pressable>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => setScreen("saved")}
                  >
                    <Text style={styles.secondaryButtonText}>Saved</Text>
                  </Pressable>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={togglePause}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {isPaused ? "Resume" : "Pause"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.ghostButton}
                    onPress={stopWorkout}
                  >
                    <Text style={styles.ghostButtonText}>Stop</Text>
                  </Pressable>
                </View>
                <View style={styles.saveRow}>
                  <TextInput
                    style={styles.saveInput}
                    value={saveName}
                    onChangeText={setSaveName}
                    placeholder="Session name"
                    placeholderTextColor="#8a7f6b"
                  />
                  <Pressable style={styles.primaryButton} onPress={saveSession}>
                    <Text style={styles.primaryButtonText}>Save</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.listBlock}>
                <Text style={styles.label}>Intervals</Text>
              </View>
            </>
          }
        />

        <Modal visible={!!selected} animationType="slide" transparent>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Edit interval</Text>
              <Text style={styles.modalLabel}>Label</Text>
              <TextInput
                style={styles.modalInput}
                value={editLabel}
                onChangeText={setEditLabel}
              />
              <Text style={styles.modalLabel}>Duration (seconds)</Text>
              <TextInput
                style={styles.modalInput}
                keyboardType="number-pad"
                value={editDuration}
                onChangeText={setEditDuration}
              />
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => setSelected(null)}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={saveEdit}>
                  <Text style={styles.primaryButtonText}>Save</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal visible={!!activeSet} animationType="slide" transparent>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Edit set</Text>
              <Text style={styles.modalLabel}>Repeat count</Text>
              <TextInput
                style={styles.modalInput}
                keyboardType="number-pad"
                value={setRepeat}
                onChangeText={setSetRepeat}
              />
              <Text style={styles.modalLabel}>Intervals in set</Text>
              <View style={styles.setList}>
                {setItems.map((item, index) => (
                  <View key={item.id} style={styles.setRow}>
                    <TextInput
                      style={styles.setInput}
                      value={item.label}
                      onChangeText={(text) =>
                        setSetItems((prev) =>
                          prev.map((step, idx) =>
                            idx === index ? { ...step, label: text } : step
                          )
                        )
                      }
                    />
                    <TextInput
                      style={styles.setInputShort}
                      keyboardType="number-pad"
                      value={String(item.durationSec)}
                      onChangeText={(text) =>
                        setSetItems((prev) =>
                          prev.map((step, idx) =>
                            idx === index
                              ? { ...step, durationSec: Number(text) || 1 }
                              : step
                          )
                        )
                      }
                    />
                  </View>
                ))}
              </View>
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => setActiveSet(null)}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={saveSetEdit}>
                  <Text style={styles.primaryButtonText}>Save</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#f5efe6",
  },
  runnerScreen: {
    flex: 1,
    backgroundColor: "#f5efe6",
    padding: 24,
    paddingTop: 28,
    justifyContent: "space-between",
  },
  listContent: {
    padding: 24,
    paddingTop: 72,
    paddingBottom: 96,
    gap: 24,
  },
  hero: {
    gap: 10,
  },
  title: {
    fontSize: 34,
    fontWeight: "700",
    color: "#2a2620",
    fontFamily: "Georgia",
  },
  subtitle: {
    fontSize: 16,
    color: "#4b463d",
    lineHeight: 22,
  },
  inputBlock: {
    backgroundColor: "#fff7ee",
    borderRadius: 18,
    padding: 18,
    gap: 14,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    shadowColor: "#b9a98f",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 3,
  },
  label: {
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "#8a7f6b",
  },
  input: {
    minHeight: 120,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#fefbf6",
    borderWidth: 1,
    borderColor: "#e7ddcf",
    color: "#2b261d",
    fontSize: 16,
    textAlignVertical: "top",
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  toggleItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  toggleLabel: {
    fontSize: 14,
    color: "#4b463d",
    fontWeight: "600",
  },
  toggleValue: {
    fontSize: 14,
    color: "#6a5e4c",
    fontWeight: "600",
  },
  voiceButton: {
    backgroundColor: "#e7ddcf",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  voiceButtonActive: {
    backgroundColor: "#2a2620",
  },
  voiceButtonDisabled: {
    opacity: 0.6,
  },
  voiceButtonText: {
    color: "#2a2620",
    fontWeight: "600",
  },
  voiceButtonTextActive: {
    color: "#fef7ed",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusText: {
    color: "#4b463d",
    fontSize: 13,
  },
  noteText: {
    color: "#6a5e4c",
    fontSize: 12,
  },
  presetsBlock: {
    gap: 14,
  },
  presetsRow: {
    gap: 14,
  },
  presetCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    gap: 8,
  },
  presetTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2a2620",
  },
  presetSubtitle: {
    fontSize: 12,
    color: "#6a5e4c",
  },
  localRow: {
    gap: 10,
  },
  localInput: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    color: "#2a2620",
  },
  errorText: {
    color: "#b3261e",
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    gap: 14,
    flexWrap: "wrap",
  },
  primaryButton: {
    backgroundColor: "#2a2620",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: "#fef7ed",
    fontWeight: "600",
    fontSize: 14,
  },
  secondaryButton: {
    backgroundColor: "#e7ddcf",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  secondaryButtonText: {
    color: "#2a2620",
    fontWeight: "600",
    fontSize: 14,
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: "#c7bca9",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  ghostButtonText: {
    color: "#6a5e4c",
    fontWeight: "600",
    fontSize: 14,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  summaryText: {
    color: "#4b463d",
    fontSize: 14,
    fontWeight: "600",
  },
  controlsBlock: {
    gap: 14,
  },
  controlsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
  },
  saveRow: {
    flexDirection: "row",
    gap: 14,
    alignItems: "center",
  },
  saveInput: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    color: "#2a2620",
  },
  nowPlaying: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: "#fff7ee",
    borderWidth: 1,
    borderColor: "#e7ddcf",
    gap: 4,
  },
  nowLabel: {
    fontSize: 12,
    color: "#8a7f6b",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  nowTitle: {
    fontSize: 16,
    color: "#2a2620",
    fontWeight: "600",
  },
  nowTime: {
    fontSize: 14,
    color: "#6a5e4c",
    fontWeight: "600",
  },
  listBlock: {
    gap: 14,
  },
  list: {
    gap: 12,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: "#f0e6d8",
    marginBottom: 12,
  },
  cardActive: {
    borderColor: "#2a2620",
    shadowColor: "#2a2620",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 4,
  },
  cardCurrent: {
    borderColor: "#c28b2c",
    backgroundColor: "#fff3dd",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#2a2620",
  },
  cardTime: {
    fontSize: 14,
    color: "#6a5e4c",
    fontWeight: "600",
  },
  cardHint: {
    marginTop: 6,
    fontSize: 12,
    color: "#8a7f6b",
  },
  cardMeta: {
    marginTop: 6,
    fontSize: 12,
    color: "#6a5e4c",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(33, 27, 20, 0.4)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: "#fff7ee",
    borderRadius: 20,
    padding: 22,
    gap: 14,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#2a2620",
  },
  modalLabel: {
    fontSize: 12,
    color: "#8a7f6b",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  modalInput: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    color: "#2a2620",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 8,
  },
  setList: {
    gap: 12,
  },
  setRow: {
    flexDirection: "row",
    gap: 10,
  },
  setInput: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    color: "#2a2620",
  },
  setInputShort: {
    width: 80,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    color: "#2a2620",
    textAlign: "center",
  },
  runnerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  runnerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#2a2620",
  },
  timerWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 280,
  },
  timerPulse: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#f0d9b4",
  },
  timerCore: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: "#fff7ee",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e7ddcf",
  },
  timerLabel: {
    fontSize: 12,
    color: "#8a7f6b",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  timerText: {
    fontSize: 32,
    fontWeight: "700",
    color: "#2a2620",
  },
  runnerInfo: {
    alignItems: "center",
    gap: 8,
  },
  runnerActivity: {
    fontSize: 20,
    fontWeight: "600",
    color: "#2a2620",
    textAlign: "center",
  },
  runnerFooter: {
    alignItems: "center",
  },
  savedHeader: {
    padding: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  savedList: {
    padding: 24,
    gap: 14,
  },
  savedCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e7ddcf",
    gap: 10,
  },
  savedTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2a2620",
  },
  savedSubtitle: {
    fontSize: 12,
    color: "#6a5e4c",
  },
  savedActions: {
    flexDirection: "row",
    gap: 12,
  },
});
