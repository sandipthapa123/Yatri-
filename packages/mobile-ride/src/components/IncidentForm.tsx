import {
  INCIDENT_CATEGORIES,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_DESCRIPTION_MAX,
  INCIDENT_DESCRIPTION_MIN,
  type IncidentBody,
  type IncidentCategory,
} from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ActionButton, Card, type UiProps } from './RideUi';

/**
 * Report a safety concern about this ride. The category list and the length limits come from
 * @yatri/types (the server enforces the same ones); this only collects and sends. Emergencies are
 * pointed at the SOS control and the phone: a report is read later, an SOS is read now.
 */
export function IncidentForm(
  props: UiProps & {
    onSubmit: (body: IncidentBody) => Promise<boolean>;
    onCancel: () => void;
    emergencyNumber?: string;
  },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [category, setCategory] = useState<IncidentCategory | null>(null);
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const ready = category !== null && description.trim().length >= INCIDENT_DESCRIPTION_MIN;
  return (
    <Card {...ui} title="Report a safety concern" focusOnMount>
      <Text style={{ color: colors.textSecondary }}>
        {`If you are in danger now, use Emergency SOS or call ${props.emergencyNumber ?? '100'}. This report is read by our safety team afterwards.`}
      </Text>
      <View accessibilityRole="radiogroup" style={styles.group}>
        {INCIDENT_CATEGORIES.map((c) => (
          <ActionButton
            key={c}
            {...ui}
            role="radio"
            selected={category === c}
            label={INCIDENT_CATEGORY_LABELS[c]}
            onPress={() => setCategory(c)}
          />
        ))}
      </View>
      <TextInput
        value={description}
        onChangeText={setDescription}
        placeholder="What happened?"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="What happened?"
        maxLength={INCIDENT_DESCRIPTION_MAX}
        multiline
        style={[
          styles.input,
          { minHeight: minTouchTarget * 2, color: colors.textPrimary, borderColor: colors.border },
        ]}
      />
      <ActionButton
        {...ui}
        label="Send report"
        tone="primary"
        disabled={!ready}
        busy={sending}
        hint={
          ready
            ? undefined
            : category === null
              ? 'Choose what kind of concern this is'
              : `Write at least ${INCIDENT_DESCRIPTION_MIN} characters`
        }
        onPress={() => {
          if (!category) return;
          setSending(true);
          void props.onSubmit({ category, description: description.trim() }).finally(() => {
            setSending(false);
          });
        }}
      />
      <ActionButton {...ui} label="Cancel" onPress={props.onCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
});
