
import { Link, useLocation } from 'react-router-dom';
import { Twitter, Linkedin, Github } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';

const Footer = () => {
  const location = useLocation();
  const { t } = useLanguage();
  const { user } = useAuth();

  const hiddenRoutes = ['/login', '/signup'];
  if (user || hiddenRoutes.includes(location.pathname)) {
    return null;
  }
  
  const handleNavigation = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    } else if (window.location.pathname !== '/') {
      window.location.href = `/?section=${sectionId}`;
    }
  };

  const goToPrivacyPolicy = () => {
    if (location.pathname !== '/privacy') {
      window.location.href = '/privacy';
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goToTermsOfService = () => {
    if (location.pathname !== '/terms') {
      window.location.href = '/terms';
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goToContact = () => {
    if (location.pathname !== '/contact') {
      window.location.href = '/contact';
    }
  };

  const goToSupport = () => {
    window.location.href = '/support';
  };

  const goToAbout = () => {
    if (location.pathname !== '/about') {
      window.location.href = '/about';
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goToDashboard = () => {
    if (location.pathname !== '/') {
      window.location.href = '/';
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <footer className="bg-gray-900 text-white relative z-40">
      <div className="pt-16 pb-8">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
            <div className="lg:col-span-1">
              <span className="text-lg font-semibold text-white">InventorySprint</span>
              <p className="text-muted-foreground text-sm mt-2">a Pedu Company</p>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-4">{t("footer.company")}</h3>
              <ul className="space-y-2">
                <li><a onClick={goToAbout} className="text-muted-foreground hover:text-white transition-colors cursor-pointer">{t("footer.about")}</a></li>
                <li><a onClick={goToContact} className="text-muted-foreground hover:text-white transition-colors cursor-pointer">{t("nav.contact")}</a></li>
                <li><a onClick={goToPrivacyPolicy} className="text-muted-foreground hover:text-white transition-colors cursor-pointer">{t("footer.privacy_policy")}</a></li>
                <li><a onClick={goToTermsOfService} className="text-muted-foreground hover:text-white transition-colors cursor-pointer">{t("footer.terms_of_service")}</a></li>
              </ul>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-4">Blog</h3>
              <ul className="space-y-2">
                <li><Link to="/blog/ai-repricer-behind-the-scenes" className="text-muted-foreground hover:text-white transition-colors">How AI Repricer Works</Link></li>
                <li><Link to="/blog/real-ai-decisions-live-asins" className="text-muted-foreground hover:text-white transition-colors">Real AI Decisions</Link></li>
                <li><Link to="/blog/what-ai-repricer-looks-at" className="text-muted-foreground hover:text-white transition-colors">What AI Looks At</Link></li>
                <li><Link to="/blog/product-library-amazon-sellers" className="text-muted-foreground hover:text-white transition-colors">Product Library</Link></li>
                <li><Link to="/blog/repricer-features" className="text-muted-foreground hover:text-white transition-colors">Repricer Features</Link></li>
                <li><Link to="/blog/what-repricer-does" className="text-muted-foreground hover:text-white transition-colors">What Repricer Does</Link></li>
                <li><Link to="/blog/two-sellers-one-asin" className="text-muted-foreground hover:text-white transition-colors">Two Sellers, One ASIN</Link></li>
                <li><Link to="/blog/arbitrage-vs-wholesale-repricing" className="text-muted-foreground hover:text-white transition-colors">Arbitrage vs Wholesale Repricing</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 pt-8 mt-8">
            <div className="flex flex-col md:flex-row justify-between items-center">
              <p className="text-gray-500 text-sm order-2 md:order-1">
                {t("footer.copyright")}
              </p>
              <div className="flex space-x-6 mb-4 md:mb-0 order-1 md:order-2">
                <a onClick={goToPrivacyPolicy} className="text-muted-foreground text-sm hover:text-white transition-colors cursor-pointer">
                  {t("footer.privacy_policy")}
                </a>
                <a onClick={goToTermsOfService} className="text-muted-foreground text-sm hover:text-white transition-colors cursor-pointer">
                  {t("footer.terms_of_service")}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
