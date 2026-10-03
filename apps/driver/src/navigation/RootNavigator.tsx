import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createSignInScreens, useAuth, type SignInRoutes } from '@yatri/mobile-auth';

import { DriverHomeScreen } from '../screens/DriverHomeScreen';
import { DriverLocationScreen } from '../screens/DriverLocationScreen';
import { DriverEmergencyContactsScreen } from '../screens/DriverEmergencyContactsScreen';
import { DriverRideHistoryScreen } from '../screens/DriverRideHistoryScreen';
import { DriverTripScreen } from '../screens/DriverTripScreen';
import { DriverProfileSetupScreen } from '../screens/DriverProfileSetupScreen';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen';
import { VerificationPendingScreen } from '../screens/VerificationPendingScreen';
import { IncentivesScreen } from '../screens/IncentivesScreen';
import { PayoutsScreen } from '../screens/PayoutsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SupportScreen, type SupportRoute } from '@yatri/mobile-support';
import { VehicleAccessibilityScreen } from '../screens/VehicleAccessibilityScreen';
import { SIGN_IN } from '../brand';

// The sign-in steps are the shared ones (@yatri/mobile-auth), with their shared routes.
export type RootStackParamList = SignInRoutes & SupportRoute & {
  Settings: undefined;
  VehicleAccessibility: undefined;
  Incentives: undefined;
  Payouts: undefined;
  DriverProfileSetup: undefined;
  Onboarding: undefined;
  VerificationPending: undefined;
  DriverLocation: undefined;
  DriverTrip: { tripId: string };
  DriverRideHistory: undefined;
  DriverEmergencyContacts: undefined;
  DriverHome: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const { WelcomeScreen, PhoneEntryScreen, OtpVerificationScreen } = createSignInScreens(SIGN_IN);

/**
 * Same "swap the screen list on auth status" pattern as the passenger app.
 * A returning driver always starts at Onboarding: it fetches live progress
 * from the server and immediately redirects to VerificationPending itself
 * once the application has been submitted, so routing never depends on the
 * AuthContext's `driverStatus` cache (which goes stale after an app restart
 * — it's only refreshed by login or an explicit profile update).
 */
export function RootNavigator() {
  const { status, isNewUser } = useAuth();

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={
          status === 'authenticated' ? (isNewUser ? 'DriverProfileSetup' : 'Onboarding') : undefined
        }
      >
        {status === 'authenticated' ? (
          <>
            <Stack.Screen name="Onboarding" component={OnboardingScreen} />
            <Stack.Screen name="VerificationPending" component={VerificationPendingScreen} />
            <Stack.Screen name="DriverProfileSetup" component={DriverProfileSetupScreen} />
            <Stack.Screen name="DriverLocation" component={DriverLocationScreen} />
            <Stack.Screen name="DriverTrip" component={DriverTripScreen} />
            <Stack.Screen name="DriverRideHistory" component={DriverRideHistoryScreen} />
            <Stack.Screen
              name="DriverEmergencyContacts"
              component={DriverEmergencyContactsScreen}
            />
            <Stack.Screen name="DriverHome" component={DriverHomeScreen} />
            <Stack.Screen name="Support" component={SupportScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="VehicleAccessibility" component={VehicleAccessibilityScreen} />
            <Stack.Screen name="Incentives" component={IncentivesScreen} />
            <Stack.Screen name="Payouts" component={PayoutsScreen} />
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
