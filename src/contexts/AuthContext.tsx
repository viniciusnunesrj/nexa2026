import React, { createContext, useContext, useState, useEffect } from 'react';
import { NexaUser, RegisterData, AuthResult, LevelUpResult } from '../types';
import { authService } from '../services/authService';
import { EconomyService } from '../services/economyService';
import { ProgressionService } from '../services/progressionService';
import { CURRENT_USER } from '../data/mockUsers';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { SupabaseService } from '../services/supabaseService';

interface AuthContextType {
  currentUser: NexaUser | null;
  user: NexaUser; // Backwards-compatible alias for existing components
  isAuthenticated: boolean;
  isFirstAccess: boolean;
  allUsers: NexaUser[];
  login: (identifier: string, password?: string) => Promise<AuthResult>;
  loginAsDemo: () => Promise<AuthResult>;
  register: (data: RegisterData) => Promise<AuthResult>;
  logout: () => void;
  switchUser: (userId: string) => void;
  syncUser: (updatedUser: NexaUser) => void;
  dismissFirstAccess: () => void;
  updateUserBalance: (deltaNEX: number, deltaNXA: number) => NexaUser | undefined;
  addXP: (amount: number) => LevelUpResult | undefined;
  addSeasonXP: (amount: number) => void;
  claimSeasonReward: (level: number) => void;
  updateUserProfile: (bio: string, title?: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Try to restore user from active local session
  const [currentUser, setCurrentUser] = useState<NexaUser | null>(() => {
    const session = authService.getCurrentUser();
    if (session) {
      // Always hydrate with latest state from EconomyService database if available
      const persisted = EconomyService.getUser(session.id);
      return persisted || session;
    }
    return null;
  });

  const [allUsers, setAllUsers] = useState<NexaUser[]>(() => {
    const users = EconomyService.getAllUsers();
    return users.length > 0 ? users : authService.getAllUsers();
  });

  // Refresh user list when needed
  const refreshUsersList = () => {
    const users = EconomyService.getAllUsers();
    setAllUsers(users.length > 0 ? users : authService.getAllUsers());
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('nexa_ranking_updated'));
    }
  };

  // Mount initialization: sync profiles from Supabase and check active Supabase Auth session
  useEffect(() => {
    authService.ensureInitialized().then(() => {
      refreshUsersList();

      if (isSupabaseConfigured()) {
        supabase.auth.getSession().then(({ data }) => {
          if (data?.session?.user) {
            SupabaseService.fetchProfile(data.session.user.id).then((profile) => {
              if (profile) {
                setCurrentUser(profile);
                refreshUsersList();
              }
            });
          }
        });

        const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
          if (event === 'SIGNED_IN' && session?.user) {
            const profile = await SupabaseService.fetchProfile(session.user.id);
            if (profile) {
              setCurrentUser(profile);
              refreshUsersList();
            }
          } else if (event === 'SIGNED_OUT') {
            setCurrentUser(null);
            refreshUsersList();
          }
        });

        return () => {
          authListener.subscription.unsubscribe();
        };
      }
    });
  }, []);

  const login = async (identifier: string, password?: string): Promise<AuthResult> => {
    const result = await authService.login(identifier, password);
    if (result.success && result.user) {
      setCurrentUser(result.user);
      refreshUsersList();
    }
    return result;
  };

  const loginAsDemo = async (): Promise<AuthResult> => {
    const result = await authService.loginAsDemo();
    if (result.success && result.user) {
      setCurrentUser(result.user);
      refreshUsersList();
    }
    return result;
  };

  const register = async (data: RegisterData): Promise<AuthResult> => {
    const result = await authService.register(data);
    if (result.success && result.user) {
      setCurrentUser(result.user);
      refreshUsersList();
    }
    return result;
  };

  const logout = () => {
    authService.logout();
    setCurrentUser(null);
  };

  const switchUser = (userId: string) => {
    const target = allUsers.find((u) => u.id === userId);
    if (target) {
      authService.updateUser(target);
      setCurrentUser(target);
    }
  };

  const syncUser = (updatedUser: NexaUser) => {
    setCurrentUser(updatedUser);
    refreshUsersList();
  };

  const dismissFirstAccess = () => {
    if (currentUser) {
      authService.dismissFirstAccess(currentUser.id);
      setCurrentUser((prev) => (prev ? { ...prev, isFirstAccess: false } : null));
    }
  };

  const updateUserBalance = (deltaNEX: number, deltaNXA: number): NexaUser | undefined => {
    if (!currentUser) return undefined;
    let fresh = EconomyService.getUser(currentUser.id) || currentUser;

    if (deltaNEX !== 0) {
      if (deltaNEX > 0) {
        fresh = EconomyService.addCurrency(currentUser.id, 'NEX', deltaNEX);
      } else {
        fresh = EconomyService.removeCurrency(currentUser.id, 'NEX', Math.abs(deltaNEX));
      }
    }

    if (deltaNXA !== 0) {
      if (deltaNXA > 0) {
        fresh = EconomyService.addCurrency(currentUser.id, 'NXA', deltaNXA);
      } else {
        fresh = EconomyService.removeCurrency(currentUser.id, 'NXA', Math.abs(deltaNXA));
      }
    }

    setCurrentUser(fresh);
    refreshUsersList();
    return fresh;
  };

  const addXP = (amount: number): LevelUpResult | undefined => {
    if (!currentUser) return undefined;
    const result = ProgressionService.addExperience(currentUser.id, amount);
    const updated = EconomyService.getUser(currentUser.id);
    if (updated) {
      setCurrentUser(updated);
      refreshUsersList();
    }
    return result;
  };

  const addSeasonXP = (amount: number) => {
    if (!currentUser) return;
    const latest = EconomyService.getUser(currentUser.id) || currentUser;
    let xp = latest.seasonXP + amount;
    let lvl = latest.seasonLevel;
    const xpPerLevel = 1000;

    while (xp >= xpPerLevel && lvl < 20) {
      xp -= xpPerLevel;
      lvl += 1;
    }

    const updated: NexaUser = {
      ...latest,
      seasonXP: xp,
      seasonLevel: lvl,
    };
    EconomyService.saveUser(updated);
    setCurrentUser(updated);
    refreshUsersList();
  };

  const claimSeasonReward = (level: number) => {
    if (!currentUser) return;
    const latest = EconomyService.getUser(currentUser.id) || currentUser;
    if (latest.claimedSeasonRewards.includes(level)) return;

    const updated: NexaUser = {
      ...latest,
      claimedSeasonRewards: [...latest.claimedSeasonRewards, level],
    };
    EconomyService.saveUser(updated);
    setCurrentUser(updated);
    refreshUsersList();
  };

  const updateUserProfile = (bio: string, title?: string) => {
    if (!currentUser) return;
    const latest = EconomyService.getUser(currentUser.id) || currentUser;
    const updated: NexaUser = {
      ...latest,
      bio,
      title: title !== undefined ? title : latest.title,
    };
    EconomyService.saveUser(updated);
    setCurrentUser(updated);
    refreshUsersList();
  };

  // Safe fallback for user object so components don't crash when logged out
  const fallbackUser: NexaUser = currentUser || CURRENT_USER;
  const isAuthenticated = currentUser !== null;
  const isFirstAccess = Boolean(currentUser?.isFirstAccess);

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        user: fallbackUser,
        isAuthenticated,
        isFirstAccess,
        allUsers,
        login,
        loginAsDemo,
        register,
        logout,
        switchUser,
        syncUser,
        dismissFirstAccess,
        updateUserBalance,
        addXP,
        addSeasonXP,
        claimSeasonReward,
        updateUserProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
