
import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import NavbarLogo from "./navbar/NavbarLogo";
import NavbarLinks from "./navbar/NavbarLinks";
import NavbarMobileMenu from "./navbar/NavbarMobileMenu";


interface NavbarProps {
  /** Hides the mobile hamburger menu button (and its dropdown). Desktop nav is unaffected. */
  hideMobileMenuButton?: boolean;
}

const Navbar = ({ hideMobileMenuButton = false }: NavbarProps = {}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isHomePage = location.pathname === '/';

  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 20) {
        setIsScrolled(true);
      } else {
        setIsScrolled(false);
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen);
  };

  const goToHome = () => {
    navigate('/');
  };

  const handleNavigation = (section: string) => {
    if (isHomePage) {
      const element = document.getElementById(section);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    } else {
      navigate(`/?section=${section}`);
    }
    setMobileMenuOpen(false);
  };

  return (
    <nav
      className={cn(
        "fixed w-full z-50 transition-all duration-300 py-4",
        (isScrolled || !isHomePage) ? "bg-[hsl(222,84%,4.9%)]/95 backdrop-blur-md shadow-lg" : "bg-transparent"
      )}
    >
      <div className="container mx-auto flex items-center">
        <NavbarLogo onClick={goToHome} />
        <div className="hidden md:flex items-center ml-4">
          <NavbarLinks
            goToHome={goToHome}
            handleNavigation={handleNavigation}
          />
        </div>

        <div className="md:hidden flex items-center space-x-2 ml-auto">
          {!user && (
            <Button
              size="sm"
              onClick={() => { setMobileMenuOpen(false); navigate('/login'); }}
              className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-3 h-9"
            >
              Login
            </Button>
          )}
          {!hideMobileMenuButton && user && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleMobileMenu}
              aria-label="Toggle Menu"
              className="text-white"
            >
              {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </Button>
          )}
        </div>
      </div>

      {!hideMobileMenuButton && user && mobileMenuOpen && (
        <NavbarMobileMenu
          goToHome={goToHome}
          handleNavigation={handleNavigation}
        />
      )}
    </nav>
  );
};

export default Navbar;
