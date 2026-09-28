import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';

import { DriverProfileSetupScreen } from '../screens/DriverProfileSetupScreen';
import { OtpVerificationScreen } from '../screens/OtpVerificationScreen';
import { PhoneEntryScreen } from '../screens/PhoneEntryScreen';
import { VerificationPendingScreen } from '../screens/VerificationPendingScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';

export type RootStackParamList = {
  Welcome: undefined;
  PhoneEntry: undefined;
  OtpVerification: { phoneNumber: string };
  DriverProfileSetup: undefined;
  VerificationPending: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Same "swap the screen list on auth status" pattern as the passenger app.
 * A verified driver still lands on VerificationPending for now — ride
 * acceptance (the reason verification matters) doesn't exist yet, so
 * there's no "driver home" to show even once VERIFIED.
 */
export function RootNavigator() {
  const { status, isNewUser } = useAuth();

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={
          status === 'authenticated' && isNewUser ? 'DriverProfileSetup' : undefined
        }
      >
        {status === 'authenticated' ? (
          <>
            <Stack.Screen name="VerificationPending" component={VerificationPendingScreen} />
            <Stack.Screen name="DriverProfileSetup" component={DriverProfileSetupScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="OtpVerification" component={OtpVerificationScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
